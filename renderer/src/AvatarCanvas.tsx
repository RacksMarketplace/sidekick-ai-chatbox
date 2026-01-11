import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const vrmUrl = new URL("../../niko.vrm", import.meta.url).href;

function VRMAvatar() {
  const [vrm, setVrm] = useState<VRM | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const vrmRef = useRef<VRM | null>(null);

  useEffect(() => {
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
          const mixer = new THREE.AnimationMixer(loadedVrm.scene);
          gltf.animations.forEach((clip) => {
            mixer.clipAction(clip).play();
          });
          mixerRef.current = mixer;
        }

        vrmRef.current = loadedVrm;
        setVrm(loadedVrm);
      },
      undefined,
      () => {
        // Intentionally silent to avoid console noise during startup.
      }
    );

    return () => {
      mixerRef.current = null;
      vrmRef.current?.dispose();
      vrmRef.current = null;
    };
  }, []);

  useFrame((state, delta) => {
    if (!vrm) return;

    if (mixerRef.current) {
      mixerRef.current.update(delta);
    } else {
      const t = state.clock.elapsedTime;
      vrm.scene.rotation.y = Math.PI + Math.sin(t * 0.5) * 0.08;
      vrm.scene.position.y = -0.85 + Math.sin(t * 1.2) * 0.02;
    }

    vrm.update(delta);
  });

  if (!vrm) return null;

  return <primitive object={vrm.scene} />;
}

export default function AvatarCanvas() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      <Canvas
        camera={{ position: [0, 1.35, 2.25], fov: 30 }}
        gl={{ alpha: true, antialias: true }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(0x000000), 0);
        }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[1.5, 2.5, 2]} intensity={1.1} />
        <directionalLight position={[-1.5, 1.2, 1.5]} intensity={0.4} />
        <VRMAvatar />
      </Canvas>
    </div>
  );
}
