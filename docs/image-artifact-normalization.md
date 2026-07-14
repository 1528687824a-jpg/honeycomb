# Image Artifact Normalization

Honeycomb normalizes generated still images immediately before durable delivery.
The provider file remains unchanged; any required conversion is written as a
derived file below the job workspace and recorded as a separate canonical
artifact file.

## Completion Contract

A required image deliverable can complete only when the final media gate reads
the real local file and confirms every requested field:

- raster format from decoded metadata rather than filename or MIME text;
- visible width and height after EXIF orientation;
- non-empty file below the job workspace;
- byte count and SHA-256 checksum stored with the artifact file.

Supported normalized output formats are PNG, JPEG, WebP, and static GIF. PNG
and WebP preserve alpha. JPEG cannot contain alpha, so transparent pixels are
flattened onto white before encoding.

## Resize Policy

- With no requested dimensions, only format conversion and EXIF orientation
  correction are applied.
- With one requested dimension, aspect ratio is preserved and the other
  dimension is calculated.
- With both dimensions, Honeycomb produces that exact canvas using
  attention-based `cover` cropping.
- The default maximum crop is 15 percent of source area. A larger mismatch
  fails with `image_aspect_ratio_crop_too_large` instead of silently damaging
  the composition.

JPEG output uses quality 94, progressive scans, and 4:4:4 chroma. WebP uses
quality 92 and full alpha quality. PNG is lossless. Metadata is removed after
EXIF orientation is applied and output is converted to sRGB.

## Durability And Safety

The normalized filename is derived from the source SHA-256 and requested
format/dimensions. A DBOS retry therefore reuses the same verified output after
a worker restart. An invalid or interrupted cached output is rebuilt.

Sharp/libvips runs with bounded input bytes, output bytes, input pixels, output
pixels, dimensions, crop fraction, and processing time. Source and output paths
must remain below the canonical job workspace. Output is written to a unique
temporary file, flushed, decoded again, checked for exact format/dimensions,
and atomically renamed before the database record is updated.

Configuration defaults:

```text
HONEYCOMB_IMAGE_NORMALIZE_MAX_INPUT_BYTES=52428800
HONEYCOMB_IMAGE_NORMALIZE_MAX_OUTPUT_BYTES=104857600
HONEYCOMB_IMAGE_NORMALIZE_MAX_INPUT_PIXELS=100000000
HONEYCOMB_IMAGE_NORMALIZE_MAX_OUTPUT_PIXELS=100000000
HONEYCOMB_IMAGE_NORMALIZE_MAX_DIMENSION=32768
HONEYCOMB_IMAGE_NORMALIZE_MAX_CROP_FRACTION=0.15
HONEYCOMB_IMAGE_NORMALIZE_TIMEOUT_SECONDS=60
```

Focused verification:

```powershell
node --import tsx --test tests/image-normalization.test.ts tests/image-normalization-policy.test.ts tests/artifact-delivery-policy.test.ts
```
