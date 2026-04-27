# Coffee Maker Timer

An interactive 3D coffee maker with a realistic brewing simulation, countdown timer, and live coffee fill animation. Built with Three.js, no build step required.

## Features

- 3D coffee maker model with orbit/zoom controls
- Brewing simulation with heating, brewing, and done phases
- Animated coffee fill that grows inside the carafe as brewing progresses
- Adjustable cup count (1–12) with accurate brew time estimate
- Speed multiplier (1×–30×) changeable at any point during brewing
- Machine color picker (8 colours)
- Ambient sound: heating hum, drip sounds, and a done chime

## Local development

Requires a local HTTP server because the GLB model cannot be loaded over `file://`.

```bash
python -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

Any static file server works — for example with Node.js:

```bash
npx serve .
```

## Project structure

```
coffee-maker-timer/
├── index.html               # App shell and control panel markup
├── style.css                # Design system (dark theme, amber accents)
├── main.js                  # Three.js scene, state machine, audio, UI wiring
├── moccamaster-optimized.glb  # 3D model (Moccamaster by niko.rummukainen, CC BY 4.0)
└── sounds/
    ├── README.txt           # Instructions for supplying the audio file
    └── coffee-hum.mp3       # Optional looping brew sound (CC0, user-supplied)
```

## Model

The app loads `moccamaster-optimized.glb` from the project root. To use a different model, place any GLTF/GLB file there and update the filename in [main.js](main.js). The scene auto-scales the model to fit and detects the carafe glass to position the coffee fill overlay.

## Audio

Place a looping coffee-machine sound at `sounds/coffee-hum.mp3`. If the file is absent, the app falls back to a synthesized hum generated with the Web Audio API. The done chime is always synthesized.

Good free sources: [Freesound.org](https://freesound.org) — search "coffee maker" and filter by CC0.

## Credits

3D model: [Moccamaster](https://sketchfab.com/3d-models/moccamaster-903906cf2a864ec8bd200982919295e2) by [niko.rummukainen](https://sketchfab.com/niko.rummukainen) — licensed under [CC Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
