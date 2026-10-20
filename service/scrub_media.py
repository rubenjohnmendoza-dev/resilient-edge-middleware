from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import pikepdf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}
SUPPORTED_EXTENSIONS = IMAGE_EXTENSIONS | {".pdf"}
MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
}
SCRUB_ROOT = Path(os.environ.get("REM_SCRUB_ROOT") or Path.cwd()).resolve()


class ScrubError(RuntimeError):
    """Raised when a media file cannot be safely scrubbed or verified."""


@dataclass(frozen=True)
class ScrubResult:
    input_path: str
    output_path: str
    format: str
    bytes: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": "scrubbed",
            "input_path": self.input_path,
            "output_path": self.output_path,
            "format": self.format,
            "bytes": self.bytes,
        }


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


MAX_UPLOAD_BYTES = _env_int("REM_MAX_UPLOAD_BYTES", 50 * 1024 * 1024)


def _atomic_write(
    destination: Path,
    writer: Callable[[Path], None],
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=destination.suffix,
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    temporary_path.unlink(missing_ok=True)

    try:
        writer(temporary_path)
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def _verify_image(path: Path) -> None:
    with Image.open(path) as image:
        if len(image.getexif()) > 0:
            raise ScrubError("EXIF metadata remains after scrubbing")

        for key in (
            "exif",
            "xmp",
            "XML:com.adobe.xmp",
            "icc_profile",
            "comment",
            "c2pa",
            "jumbf",
        ):
            if image.info.get(key):
                raise ScrubError(f"Image metadata field {key!r} remains")

        if getattr(image, "text", None):
            raise ScrubError("PNG text metadata remains after scrubbing")


def _scrub_image(source: Path, destination: Path) -> None:
    try:
        with Image.open(source) as image:
            image.load()
            image_format = (image.format or "").upper()

            if image_format not in {"PNG", "JPEG", "MPO"}:
                raise ScrubError(
                    f"Unsupported image format: {image_format or 'unknown'}"
                )

            transparency = image.info.get("transparency")
            cleaned = ImageOps.exif_transpose(image)
            cleaned.info = {}
            cleaned.getexif().clear()

            if image_format in {"JPEG", "MPO"}:
                if cleaned.mode not in {"RGB", "L"}:
                    cleaned = cleaned.convert("RGB")
                cleaned.save(
                    destination,
                    format="JPEG",
                    quality=95,
                    optimize=True,
                )
            else:
                if transparency is not None:
                    cleaned.info["transparency"] = transparency
                cleaned.save(destination, format="PNG", optimize=True)
    except UnidentifiedImageError as error:
        raise ScrubError(f"Unrecognized image file: {source}") from error
    except OSError as error:
        raise ScrubError(f"Unable to process image {source}: {error}") from error

    _verify_image(destination)


def _delete_key(mapping: Any, key: str) -> None:
    if key in mapping:
        del mapping[key]


def _clear_pdf_metadata(pdf: pikepdf.Pdf) -> None:
    try:
        pdf.docinfo.clear()
    except Exception:
        pass

    _delete_key(pdf.trailer, "/Info")
    _delete_key(pdf.Root, "/Metadata")
    _delete_key(pdf.Root, "/PieceInfo")
    _delete_key(pdf.Root, "/AF")

    names = pdf.Root.get("/Names")
    if names is not None:
        _delete_key(names, "/EmbeddedFiles")

    for page in pdf.pages:
        page_object = page.obj
        _delete_key(page_object, "/Metadata")
        _delete_key(page_object, "/PieceInfo")
        _delete_key(page_object, "/AF")


def _verify_pdf(path: Path) -> None:
    with pikepdf.open(path) as pdf:
        if len(pdf.docinfo) > 0:
            raise ScrubError("PDF document info remains after scrubbing")

        for key in ("/Metadata", "/PieceInfo", "/AF"):
            if key in pdf.Root:
                raise ScrubError(f"PDF metadata key {key} remains")

        names = pdf.Root.get("/Names")
        if names is not None and "/EmbeddedFiles" in names:
            raise ScrubError("PDF embedded files remain after scrubbing")

        for page in pdf.pages:
            for key in ("/Metadata", "/PieceInfo", "/AF"):
                if key in page.obj:
                    raise ScrubError(f"PDF page metadata key {key} remains")


def _scrub_pdf(source: Path, destination: Path) -> None:
    try:
        with pikepdf.open(source) as pdf:
            _clear_pdf_metadata(pdf)
            pdf.save(destination)
    except (pikepdf.PdfError, OSError) as error:
        raise ScrubError(f"Unable to process PDF {source}: {error}") from error

    _verify_pdf(destination)


def scrub_file(source: str | Path, destination: str | Path) -> ScrubResult:
    source_path = Path(source).expanduser().resolve()
    destination_path = Path(destination).expanduser().resolve()

    if not source_path.is_file():
        raise ScrubError(f"Input file does not exist: {source_path}")

    suffix = source_path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        writer: Callable[[Path, Path], None] = _scrub_image
    elif suffix == ".pdf":
        writer = _scrub_pdf
    else:
        raise ScrubError(
            f"Unsupported file type {suffix!r}; expected PNG, JPEG, or PDF"
        )

    _atomic_write(
        destination_path,
        lambda temporary_path: writer(source_path, temporary_path),
    )

    return ScrubResult(
        input_path=str(source_path),
        output_path=str(destination_path),
        format=suffix.lstrip("."),
        bytes=destination_path.stat().st_size,
    )


def _resolve_http_path(raw_path: str, *, must_exist: bool) -> Path:
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = SCRUB_ROOT / candidate
    candidate = candidate.resolve()

    try:
        candidate.relative_to(SCRUB_ROOT)
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=f"Path must stay within {SCRUB_ROOT}",
        ) from error

    if must_exist and not candidate.is_file():
        raise HTTPException(status_code=404, detail="Input file not found")

    return candidate


app = FastAPI(title="REM Media Scrubber", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "rem-media-scrubber",
        "supported": sorted(SUPPORTED_EXTENSIONS),
        "root": str(SCRUB_ROOT),
    }


@app.post("/scrub")
async def scrub_path_endpoint(request: dict[str, Any]) -> dict[str, Any]:
    raw_path = request.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise HTTPException(status_code=400, detail="'path' is required")

    source = _resolve_http_path(raw_path, must_exist=True)
    raw_output = request.get("output_path")

    if raw_output is None:
        destination = (SCRUB_ROOT / "scrubbed" / source.name).resolve()
    elif isinstance(raw_output, str) and raw_output.strip():
        destination = _resolve_http_path(raw_output, must_exist=False)
    else:
        raise HTTPException(
            status_code=400,
            detail="'output_path' must be a non-empty string",
        )

    try:
        return scrub_file(source, destination).as_dict()
    except ScrubError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/scrub/upload")
async def scrub_upload_endpoint(
    file: UploadFile = File(...),
) -> Response:
    filename = Path(file.filename or "upload").name
    suffix = Path(filename).suffix.lower()

    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Only PNG, JPEG, and PDF files are supported",
        )

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Upload exceeds {MAX_UPLOAD_BYTES} bytes",
        )

    with tempfile.TemporaryDirectory(prefix="rem-scrub-") as temporary_dir:
        source = Path(temporary_dir) / f"input{suffix}"
        destination = Path(temporary_dir) / f"scrubbed{suffix}"
        source.write_bytes(payload)

        try:
            scrub_file(source, destination)
        except ScrubError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        output = destination.read_bytes()

    safe_name = filename.replace('"', "")
    return Response(
        content=output,
        media_type=MEDIA_TYPES[suffix],
        headers={
            "content-disposition": (
                f'attachment; filename="scrubbed-{safe_name}"'
            ),
            "x-rem-scrubbed": "true",
        },
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Strip image/PDF metadata and embedded credentials."
    )
    parser.add_argument("files", nargs="+", help="PNG, JPEG, or PDF input files")
    parser.add_argument(
        "--output-dir",
        default="scrubbed",
        help="Directory for scrubbed copies (default: scrubbed)",
    )
    parser.add_argument(
        "--output",
        help="Explicit output path; only valid with one input file",
    )
    args = parser.parse_args(argv)

    if args.output and len(args.files) != 1:
        parser.error("--output can only be used with one input file")

    output_dir = Path(args.output_dir).expanduser()

    for raw_path in args.files:
        source = Path(raw_path).expanduser()
        destination = (
            Path(args.output).expanduser()
            if args.output
            else output_dir / source.name
        )

        try:
            result = scrub_file(source, destination)
        except ScrubError as error:
            print(
                json.dumps(
                    {
                        "status": "error",
                        "input_path": str(source),
                        "error": str(error),
                    }
                ),
                file=sys.stderr,
            )
            return 1

        print(json.dumps(result.as_dict()))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
