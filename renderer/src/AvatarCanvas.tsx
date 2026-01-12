import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const vrmUrl = "/niko.vrm";
// Mixamo animation set used to keep the avatar alive.
const animationConfigs = [{ name: "Idle", url: "/animations/Idle.fbx", loop: THREE.LoopRepeat }];

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
    // The mixer drives a base idle layer plus short overlay animations.
    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    let idleAction: THREE.AnimationAction | null = null;
    let activeOverlayAction: THREE.AnimationAction | null = null;
    let lastOverlayTime = 0;
    let nextWeightShiftTime = 0;
    let nextLookAroundTime = 0;
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

    const scheduleNextWeightShift = (time: number) => {
      nextWeightShiftTime = time + 30 + Math.random() * 60;
    };

    const scheduleNextLookAround = (time: number) => {
      nextLookAroundTime = time + 45 + Math.random() * 45;
    };

    // Crossfade an overlay animation on top of idle without stopping idle playback.
    const crossFadeTo = (name: string, durationMs = 300) => {
      if (!mixer) return;
      const action = actions.get(name);
      if (!action || action === idleAction) return;
      if (activeOverlayAction === action) return;
      const duration = durationMs / 1000;

      action.reset();
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(0);
      action.play();

      if (activeOverlayAction && activeOverlayAction !== action) {
        activeOverlayAction.fadeOut(duration);
      }
      action.fadeIn(duration);
      activeOverlayAction = action;
      lastOverlayTime = clock.getElapsedTime();
    };

    // Helper for one-shot overlays (Weight Shift, Look Around, Flair, etc.).
    const playOneShot = (name: string) => {
      crossFadeTo(name, 250);
    };

    const attachHelpersToWindow = () => {
      const globalWindow = window as Window & {
        sidekickAvatar?: {
          playOneShot: (name: string) => void;
          crossFadeTo: (name: string, durationMs?: number) => void;
        };
      };
      globalWindow.sidekickAvatar = { playOneShot, crossFadeTo };
    };

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const fbxLoader = new FBXLoader();

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
        mixer = new THREE.AnimationMixer(loadedVrm.scene);
        console.log("Humanoid bones:", Object.keys(loadedVrm.humanoid?.humanBones ?? {}));

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
        scheduleNextWeightShift(clock.getElapsedTime());
        scheduleNextLookAround(clock.getElapsedTime());

        scene.add(loadedVrm.scene);
        scene.remove(debugMesh);
        debugGeometry.dispose();
        debugMaterial.dispose();

        void (async () => {
          try {
            // Load FBX animations, retarget to the VRM humanoid, then create actions.
            const clips = await Promise.all(
              animationConfigs.map(
                (config) =>
                  new Promise<{ name: string; clip: THREE.AnimationClip; loop: THREE.AnimationAction["loop"] }>(
                    (resolve, reject) => {
                      fbxLoader.load(
                        config.url,
                        (fbx) => {
                          const clip = fbx.animations[0];
                          if (!clip) {
                            reject(new Error(`No animation clip found in ${config.url}`));
                            return;
                          }
                          console.log("Original tracks:", clip.tracks.length);
                          const retargeted = VRMUtils.retargetAnimationClip(loadedVrm, clip, {
                            fps: 30,
                          });
                          console.log("Retargeted tracks:", retargeted.tracks.length);
                          if (retargeted.tracks.length === 0) {
                            reject(
                              new Error(
                                `Retargeted clip from ${config.url} has no tracks.`
                              )
                            );
                            return;
                          }
                          resolve({ name: config.name, clip: retargeted, loop: config.loop });
                        },
                        undefined,
                        (error) => reject(error)
                      );
                    }
                  )
              )
            );

            if (!mixer) return;

            clips.forEach(({ name, clip, loop }) => {
              const action = mixer!.clipAction(clip);
              action.setLoop(loop, loop === THREE.LoopRepeat ? Infinity : 1);
              if (loop === THREE.LoopOnce) {
                action.clampWhenFinished = true;
              }
              actions.set(name, action);
            });

            // Idle runs forever at full weight; other animations fade in/out on top.
            const idle = actions.get("Idle");
            if (idle) {
              idleAction = idle;
              idleAction.setEffectiveWeight(1);
              idleAction.play();
            }

            attachHelpersToWindow();
          } catch (error) {
            console.error("Failed to load avatar animations", error);
          }
        })();
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

        if (mixer) {
          // Advance the mixer for both idle and overlay animations.
          mixer.update(delta);

          if (activeOverlayAction && activeOverlayAction.loop === THREE.LoopOnce) {
            const overlayDuration = activeOverlayAction.getClip().duration;
            if (activeOverlayAction.time >= overlayDuration) {
              activeOverlayAction.fadeOut(0.3);
              activeOverlayAction = null;
              lastOverlayTime = elapsed;
            }
          }
        }

        if (!activeOverlayAction && elapsed >= nextWeightShiftTime) {
          playOneShot("Weight Shift");
          scheduleNextWeightShift(elapsed);
        }

        if (!activeOverlayAction && elapsed - lastOverlayTime >= 30 && elapsed >= nextLookAroundTime) {
          playOneShot("Look Around");
          scheduleNextLookAround(elapsed);
        }

        vrm.update(delta);
      }
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(renderLoop);
    };

    resize();
    frameId = requestAnimationFrame(renderLoop);
    window.addEventListener("resize", resize);
    const handleFlair = () => playOneShot("Flair");
    window.addEventListener("avatar:flair", handleFlair);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("avatar:flair", handleFlair);
      const globalWindow = window as Window & { sidekickAvatar?: unknown };
      if (globalWindow.sidekickAvatar) {
        delete globalWindow.sidekickAvatar;
      }
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
