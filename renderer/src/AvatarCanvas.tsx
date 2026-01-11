import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const vrmUrl = "/niko.vrm";

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
    camera.position.set(0, 1.4, 2.2);
    camera.lookAt(0, 1.35, 0);
    scene.add(camera);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(1.5, 2.5, 2);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-1.5, 1.2, 1.5);
    scene.add(fillLight);

    const debugGeometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const debugMaterial = new THREE.MeshStandardMaterial({ color: 0x66aaff });
    const debugMesh = new THREE.Mesh(debugGeometry, debugMaterial);
    debugMesh.position.set(0, 1.2, 0);
    scene.add(debugMesh);

    let vrm: VRM | null = null;
    let chestNode: THREE.Object3D | null = null;
    let chestBaseY = 0;
    let swayTarget: THREE.Object3D | null = null;
    let swayBaseZ = 0;
    let blinkSupported = false;
    let blinkLogged = false;
    let blinkStartTime = 0;
    let blinkEndTime = 0;
    let nextBlinkTime = 0;

    const setBlinkValue = (value: number) => {
      if (!vrm) return;
      const vrmAny = vrm as unknown as {
        blendShapeProxy?: { setValue: (name: string, weight: number) => void };
        expressionManager?: { setValue: (name: string, weight: number) => void };
      };

      if (vrmAny.expressionManager?.setValue) {
        vrmAny.expressionManager.setValue("blink", value);
        return;
      }
      if (vrmAny.blendShapeProxy?.setValue) {
        vrmAny.blendShapeProxy.setValue("Blink", value);
      }
    };

    const scheduleNextBlink = (time: number) => {
      nextBlinkTime = time + 3 + Math.random() * 4;
    };

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      vrmUrl,
      (gltf) => {
        const loadedVrm = gltf.userData.vrm as VRM | undefined;
        if (!loadedVrm) {
          console.error("VRM load succeeded, but no VRM data was found in the GLTF.");
          return;
        }

        VRMUtils.rotateVRM0(loadedVrm);
        VRMUtils.removeUnnecessaryJoints(loadedVrm.scene);

        loadedVrm.scene.visible = true;
        loadedVrm.scene.position.set(0, -1.05, 0);
        loadedVrm.scene.scale.setScalar(1.0);

        loadedVrm.scene.updateMatrixWorld(true);
        const headNode = loadedVrm.humanoid?.getNormalizedBoneNode("head");
        if (headNode) {
          const headPosition = new THREE.Vector3();
          headNode.getWorldPosition(headPosition);
          camera.lookAt(headPosition);
        } else {
          camera.lookAt(0, 1.35, 0);
        }

        vrm = loadedVrm;
        const humanoid = loadedVrm.humanoid;
        const possibleChest =
          humanoid?.getNormalizedBoneNode("chest") ??
          humanoid?.getNormalizedBoneNode("spine") ??
          humanoid?.getNormalizedBoneNode("upperChest");
        if (possibleChest) {
          chestNode = possibleChest;
          chestBaseY = chestNode.position.y;
        }

        swayTarget = loadedVrm.scene;
        swayBaseZ = swayTarget.rotation.z;

        const vrmAny = loadedVrm as unknown as {
          blendShapeProxy?: { setValue: (name: string, weight: number) => void };
          expressionManager?: { setValue: (name: string, weight: number) => void };
        };
        blinkSupported = Boolean(
          vrmAny.expressionManager?.setValue || vrmAny.blendShapeProxy?.setValue
        );
        if (!blinkSupported && !blinkLogged) {
          console.warn("Blink blendshape not available; skipping idle blink.");
          blinkLogged = true;
        }
        scheduleNextBlink(clock.getElapsedTime());
        scene.add(loadedVrm.scene);
        scene.remove(debugMesh);
        debugGeometry.dispose();
        debugMaterial.dispose();
      },
      undefined,
      (error) => {
        console.error("Failed to load /niko.vrm", error);
      }
    );

    const clock = new THREE.Clock();
    let frameId = 0;

    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width === 0 || height === 0) return;

      canvas.width = width;
      canvas.height = height;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const renderLoop = () => {
      const delta = clock.getDelta();
      if (vrm) {
        const elapsed = clock.getElapsedTime();
        const breathAmplitude = 0.02;
        const breathSpeed = 1.2;
        if (chestNode) {
          chestNode.position.y = chestBaseY + Math.sin(elapsed * breathSpeed) * breathAmplitude;
        }

        const swayAmplitude = 0.03;
        const swaySpeed = 0.5;
        if (swayTarget) {
          swayTarget.rotation.z = swayBaseZ + Math.sin(elapsed * swaySpeed) * swayAmplitude;
        }

        if (blinkSupported) {
          if (elapsed >= nextBlinkTime && blinkEndTime === 0) {
            blinkStartTime = elapsed;
            blinkEndTime = elapsed + 0.12;
          }

          if (blinkEndTime > 0) {
            const progress = (elapsed - blinkStartTime) / (blinkEndTime - blinkStartTime);
            const clamped = Math.min(Math.max(progress, 0), 1);
            const blinkValue = clamped < 0.5 ? clamped * 2 : (1 - clamped) * 2;
            setBlinkValue(blinkValue);
            if (progress >= 1) {
              setBlinkValue(0);
              blinkStartTime = 0;
              blinkEndTime = 0;
              scheduleNextBlink(elapsed);
            }
          }
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
      debugGeometry.dispose();
      debugMaterial.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100vw", height: "100vh" }} />
    </div>
  );
}
