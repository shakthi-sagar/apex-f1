# Asset sources (Blender)

`apex_assets.blend` holds every hand-built 3D asset, one scene each. All are original models (no third-party meshes).

| Scene | Export | Published at (`cdn.shadster.dev/f1-sim/…`) |
|---|---|---|
| `Apex_F1Car` (collection `F1Car_Export`) | `f1-2024.glb` | `assets/cars/2024/f1-2024.glb` |
| `Apex_SafetyCar` (`SC_Export`) | `safety-car.glb` | `assets/cars/2024/safety-car.glb` |
| `Apex_Trackside` (`Floodlight`, `CameraTower`, `MarshalPost`) | `floodlight.glb`, `camera-tower.glb`, `marshal-post.glb` | `assets/environment/` |

Conventions: metres; Blender +X forward / +Z up / +Y left (glTF export converts to the app's +Y-up frame);
car origin on the ground at mid-wheelbase. The F1 car has **no wheels** (the app's procedural wheels spin/steer)
and uses role-named materials — `livery`, `carbon`, `dark`, `halo`, `helmet`, `rainlight` — which the app replaces
per team (`assets/cars/{season}/index.json` → `"default": { "recolor": true }`). The rear-wing flap is a separate
node named `DRSFlap` with its pivot at the node origin (animated when DRS is open).

Export each collection with: glTF Binary, *Active Scene* + *Active Collection*, *Apply Modifiers*, +Y Up.
