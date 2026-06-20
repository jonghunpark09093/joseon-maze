import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// Load a GLB/glTF and return its root node plus an AnimationMixer with the
// clips keyed by name. Resolves to `null` on any failure (missing file, parse
// error) so callers can fall back to their procedural visuals without breaking
// the build — the game must keep running even before the art assets exist.
export function loadModel(url) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        let mixer = null;
        const actions = {};
        if (gltf.animations?.length) {
          mixer = new THREE.AnimationMixer(root);
          for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
        }
        resolve({ root, mixer, actions, animations: gltf.animations ?? [] });
      },
      undefined,
      () => resolve(null)
    );
  });
}

// Resolve a path under the Vite base URL so it works on the GitHub Pages
// subpath as well as local dev. Assets live in `public/models/`.
export function modelUrl(name) {
  return `${import.meta.env.BASE_URL}models/${name}`;
}
