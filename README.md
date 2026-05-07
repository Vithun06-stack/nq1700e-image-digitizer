# NQ1700E Image Digitizer

Local browser tool and API for turning uploaded artwork into stitch previews, project JSON, and Brother-first machine files for the Brother Innov-is NQ1700E.

## Online app

This GitHub repository stores the code. It does not host the app by itself.

To make a public app link, deploy this repository to Vercel. The project includes a Vercel-compatible API route at `api/convert.js`.

After deployment, use the Vercel URL as the public app link.

## Run locally

This app is not hosted by GitHub automatically. The link below only works after the local Node server is running on your computer.

```bash
npm start
```

Then open:

<http://127.0.0.1:4173/>

If the browser cannot open that address, make sure the terminal still shows:

```text
NQ1700E digitizer running at http://127.0.0.1:4173/
```

## Use

1. Start the app with `npm start`, then open <http://127.0.0.1:4173/>.
2. Drop an image into the upload area, or press **Try sample**.
3. Press **Fit to hoop** if the artwork should fill the 6 x 10 inch embroidery area.
4. Choose max colours, stitch length, fill spacing, minimum line width, and the tiny-region cleanup threshold.
5. Press **Make embroidery file**.
6. Download the recommended `.pes` file, DST fallback, Brother USB package, SVG preview, PNG preview, or project JSON.
7. Copy the `.pes` file to the root of a USB drive before loading it on the machine.

## Notes

- PES is the primary export because Brother machines preserve Brother-compatible design information better with PES.
- DST remains available as a fallback because the NQ1700E can also read DST files.
- DST files do not store RGB thread colours, so follow the app's thread order list when changing colours if you use the fallback.
- The Brother USB package includes one PES file, one PNG preview, and a README with root-directory USB transfer instructions.
- Project JSON is for future editing only. It is not a machine embroidery file.
- The converter cleans artwork before stitching: transparent and near-white backgrounds are removed, visible artwork is cropped, colours are reduced, tiny regions are merged or removed, holes are filled, and edges are smoothed.
- The app classifies artwork as logo/icon, line art, photo, text-heavy, or complex illustration and shows embroidery quality warnings before export.
- Complex photos usually need cleanup before stitching because embroidery cannot reproduce every photo pixel exactly.
- The colour-change table follows the Brother guide style: stop number, thread swatch, thread number, colour value, stitch count, estimated time, and design size.

## API

`POST /api/convert`

Input fields:

- `fileName`, `fileType`, `fileSize`
- `hoopWidthIn`, `hoopHeightIn`
- `maxColors`, from 1 to 10
- `stitchLengthMm`, in millimetres
- `fillSpacingMm`, in millimetres
- `minLineWidthMm`, in millimetres
- `minRegionSize`, in pixels
- `removeTransparent`
- `image.width`, `image.height`, `image.rgba`

Output includes:

- `project`, the editable project JSON
- `files.pes`, base64 encoded Brother PES
- `files.dst`, base64 encoded Tajima DST fallback
- `files.usbPackage`, base64 encoded ZIP with PES, PNG preview, and README
- `files.svg`, SVG preview
- `files.png`, base64 encoded PNG preview
- `metadata`, including stitch count, stop count, size, thread order, colour-change sequence, image type, and quality warnings
