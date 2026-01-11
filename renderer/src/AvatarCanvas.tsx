import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const vrmUrl = new URL("../../niko.vrm", import.meta.url).href;

export default function AvatarCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(new THREE.Color(0x000000), 0);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.35, 2.25);
    scene.add(camera);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(1.5, 2.5, 2);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-1.5, 1.2, 1.5);
    scene.add(fillLight);

    let vrm: VRM | null = null;
    let mixer: THREE.AnimationMixer | null = null;

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      vrmUrl,
      (gltf) => {
        const loadedVrm = gltf.userData.vrm as VRM | undefined;
        if (!loadedVrm) return;

        VRMUtils.removeUnnecessaryJoints(loadedVrm.scene);
        loadedVrm.scene.rotation.y = Math.PI;
        loadedVrm.scene.position.set(0, -0.85, 0);
        loadedVrm.scene.scale.setScalar(1.05);

        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(loadedVrm.scene);
          gltf.animations.forEach((clip) => {
            mixer?.clipAction(clip).play();
          });
        }

        vrm = loadedVrm;
        scene.add(loadedVrm.scene);
      },
      undefined,
      () => {
        // Intentionally silent to avoid console noise during startup.
      }
    );

    const clock = new THREE.Clock();
    let frameId = 0;

    const resize = () => {
      const { clientWidth, clientHeight } = canvas;
      if (clientWidth === 0 || clientHeight === 0) return;

      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight, false);
    };

    const renderLoop = () => {
      const delta = clock.getDelta();

      if (vrm) {
        if (mixer) {
          mixer.update(delta);
        } else {
          const t = clock.elapsedTime;
          vrm.scene.rotation.y = Math.PI + Math.sin(t * 0.5) * 0.08;
          vrm.scene.position.y = -0.85 + Math.sin(t * 1.2) * 0.02;
        }

        vrm.update(delta);
      }

      renderer.render(scene, camera);
      frameId = requestAnimationFrame(renderLoop);
    };

    resize();
    frameId = requestAnimationFrame(renderLoop);
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frameId);
      vrm?.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
