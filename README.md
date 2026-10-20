# RepCounter

A responsive, browser-based dumbbell curl counter. It uses MediaPipe Pose Landmarker in your browser to estimate shoulder–elbow–wrist angles and count a full curl plus controlled return.

## Features

- Live camera view with arm landmarks overlaid
- Left/right arm selector
- Rep counter, set progress, session timer, and set history for the current session
- Movement prompts and basic elbow-angle feedback
- Camera-free demo mode
- Light/dark theme
- Pose processing runs locally in the browser; camera frames are not uploaded by this app

## Run it

Because camera access requires a secure context, use GitHub Pages (HTTPS) or a local development server. Opening `index.html` directly as a `file://` URL may block camera access.

### GitHub Pages

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.
3. The included workflow deploys the static app whenever you push to `main`.
4. After the workflow finishes, open the Pages URL shown in the repository's **Settings → Pages**.

The app loads MediaPipe and its pose model from public CDNs, so an internet connection is needed.

## Camera tips

- Allow camera permission when the browser asks.
- Use good lighting and keep your selected shoulder, elbow, and wrist visible.
- Position the camera so your arm is clearly in frame; a side-on angle can help.
- The rep counter uses approximate elbow-angle thresholds. Camera angle, occlusion, loose clothing, and lighting can affect detection.
- This is a general fitness tool, not medical advice. Use a comfortable weight and stop if you feel pain or dizziness.

## Privacy

Camera frames are processed in the browser by MediaPipe. This repository's app does not send camera frames to a server. MediaPipe libraries and the model are downloaded from public CDN/model hosting URLs.
