<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as THREE from 'three';
  import { Scene } from '../../floorplan/core/Scene';
  import { EditorRenderer } from '../../floorplan/rendering/EditorRenderer';
  import { createLightingLayers } from '../../modules/lighting/layers';
  import { fixtureSelectionOf } from '../../modules/lighting/selection';
  import { lightingData, fixtures } from '../../modules/lighting/store';
  import { moduleViewOf } from '../../floorplan/types/moduleRuntime';
  import type { ModuleView, SceneLayer } from '../../floorplan/types/moduleRuntime';
  import { roomBounds, roomStore } from '../../floorplan/stores/roomStore';
  import { displayPreferences } from '../../floorplan/stores/settingsStore';
  import { shouldFitCamera } from '../../floorplan/stores/appStore';
  import { selectedViewerLight } from './viewerStore';
  import type { BoundingBox, EditorDocument, ViewMode } from '../../floorplan/types';
  import {
    ZOOM_IN_FACTOR,
    ZOOM_OUT_FACTOR,
    PINCH_ZOOM_SENSITIVITY,
  } from '../../floorplan/constants/editor';

  export let viewMode: ViewMode = 'editor';

  let container: HTMLDivElement;
  let scene: Scene;
  let editorRenderer: EditorRenderer;
  /**
   * The viewer has no editor session and therefore no activation registry, so it owns the
   * lighting layers itself — it is the one place that builds a `ModuleView` by hand.
   */
  let lightingLayers: SceneLayer[] = [];
  let animationFrameId: number;
  let raycaster: THREE.Raycaster;

  // Pan/zoom state
  let isPanning = false;
  let lastPointerPos = { x: 0, y: 0 };
  let hasPanned = false; // Track if user has moved during mouse down

  // Touch state
  let lastTouchDist = 0;
  let lastTouchCenter = { x: 0, y: 0 };
  let activeTouches: Touch[] = [];
  let touchStartTime = 0;
  let touchStartPos = { x: 0, y: 0 };
  let hasTouchMoved = false;

  // Reactive state
  let currentRoomState: EditorDocument;
  let currentBounds: BoundingBox;

  $: currentRoomState = $roomStore;
  $: currentBounds = $roomBounds;

  // The viewer's own selection, not the editor session's, projected into the same shape a
  // layer reads. Everything else about rendering is identical to the editor's.
  $: viewerView = moduleViewOf(
    currentRoomState,
    $lightingData,
    fixtureSelectionOf($selectedViewerLight ? [$selectedViewerLight.id] : []),
    $displayPreferences,
    viewMode
  ) as ModuleView<unknown>;

  $: renderViewer(viewerView);

  $: if (
    $shouldFitCamera &&
    scene &&
    currentBounds &&
    currentRoomState.geometry.boundary.walls.length > 0
  ) {
    scene.fitToBounds(currentBounds);
    shouldFitCamera.set(false);
  }

  function renderViewer(view: ModuleView<unknown>): void {
    // One loop over core and lighting layers; each decides its own visibility from `viewMode`.
    editorRenderer?.render(view);
  }

  function animate(): void {
    scene.render();
    animationFrameId = requestAnimationFrame(animate);
  }

  // Mouse pan/zoom handlers
  function handleMouseDown(e: MouseEvent): void {
    if (e.button === 0 || e.button === 1) {
      isPanning = true;
      hasPanned = false;
      lastPointerPos = { x: e.clientX, y: e.clientY };
      if (scene) {
        scene.domElement.style.cursor = 'grabbing';
      }
    }
  }

  function handleMouseMove(e: MouseEvent): void {
    if (isPanning && scene) {
      const dx = e.clientX - lastPointerPos.x;
      const dy = e.clientY - lastPointerPos.y;

      // Mark as panned if moved more than a few pixels
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        hasPanned = true;
      }

      scene.pan(-dx, dy);
      lastPointerPos = { x: e.clientX, y: e.clientY };
    } else {
      // Update cursor based on hover
      updateCursor(e.clientX, e.clientY);
    }
  }

  function updateCursor(clientX: number, clientY: number): void {
    if (!scene || !raycaster || !editorRenderer || viewMode !== 'editor') {
      if (scene) {
        scene.domElement.style.cursor = 'grab';
      }
      return;
    }

    const rect = scene.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(new THREE.Vector2(x, y), scene.camera);
    const intersects = raycaster.intersectObjects(scene.scene.children, true);

    let isOverLight = false;
    for (const intersect of intersects) {
      if (intersect.object.userData.lightId) {
        isOverLight = true;
        break;
      }
    }

    scene.domElement.style.cursor = isOverLight ? 'pointer' : 'grab';
  }

  function handleMouseUp(e: MouseEvent): void {
    // Only handle click if we didn't pan
    if (isPanning && !hasPanned && e.button === 0) {
      handleClick(e.clientX, e.clientY);
    }
    isPanning = false;
    hasPanned = false;

    // Update cursor after mouse up
    if (scene) {
      updateCursor(e.clientX, e.clientY);
    }
  }

  function handleClick(clientX: number, clientY: number): void {
    if (!scene || !raycaster || !editorRenderer) return;

    // Only handle clicks in editor mode
    if (viewMode !== 'editor') return;

    // Get normalized device coordinates
    const rect = scene.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    // Set up raycaster
    raycaster.setFromCamera(new THREE.Vector2(x, y), scene.camera);

    // Check for intersections with light icons
    const intersects = raycaster.intersectObjects(scene.scene.children, true);

    for (const intersect of intersects) {
      // Check if we clicked on a light icon
      const lightId = intersect.object.userData.lightId;
      if (lightId) {
        // Find the light in the room state
        const light = $fixtures.find((l) => l.id === lightId);
        if (light) {
          selectedViewerLight.set(light);
          return;
        }
      }
    }

    // If we clicked outside any light, clear selection
    selectedViewerLight.set(null);
  }

  function handleWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!scene) return;

    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as a wheel event with ctrlKey set
      scene.zoomAt(
        scene.getZoom() * Math.exp(-e.deltaY * PINCH_ZOOM_SENSITIVITY),
        e.clientX,
        e.clientY
      );
    } else if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
      const zoomFactor = e.deltaY > 0 ? ZOOM_OUT_FACTOR : ZOOM_IN_FACTOR;
      scene.zoomAt(scene.getZoom() * zoomFactor, e.clientX, e.clientY);
    } else {
      scene.pan(e.deltaX, -e.deltaY);
    }
  }

  // Touch handlers
  function getTouchDist(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchCenter(t1: Touch, t2: Touch): { x: number; y: number } {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
  }

  function handleTouchStart(e: TouchEvent): void {
    e.preventDefault();
    activeTouches = Array.from(e.touches);
    hasTouchMoved = false;

    if (activeTouches.length === 1) {
      touchStartTime = Date.now();
      touchStartPos = { x: activeTouches[0].clientX, y: activeTouches[0].clientY };
      lastPointerPos = { x: activeTouches[0].clientX, y: activeTouches[0].clientY };
    } else if (activeTouches.length === 2) {
      lastTouchDist = getTouchDist(activeTouches[0], activeTouches[1]);
      lastTouchCenter = getTouchCenter(activeTouches[0], activeTouches[1]);
    }
  }

  function handleTouchMove(e: TouchEvent): void {
    e.preventDefault();
    if (!scene) return;
    const touches = Array.from(e.touches);

    if (touches.length === 1) {
      // 1-finger pan
      const dx = touches[0].clientX - lastPointerPos.x;
      const dy = touches[0].clientY - lastPointerPos.y;

      // Mark as moved if moved more than a few pixels
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        hasTouchMoved = true;
      }

      scene.pan(-dx, dy);
      lastPointerPos = { x: touches[0].clientX, y: touches[0].clientY };
    } else if (touches.length === 2) {
      hasTouchMoved = true;
      // 2-finger pinch zoom + pan
      const dist = getTouchDist(touches[0], touches[1]);
      const center = getTouchCenter(touches[0], touches[1]);

      if (lastTouchDist > 0) {
        const scale = dist / lastTouchDist;
        scene.zoomAt(scene.getZoom() * scale, center.x, center.y);
      }

      const dx = center.x - lastTouchCenter.x;
      const dy = center.y - lastTouchCenter.y;
      scene.pan(-dx, dy);

      lastTouchDist = dist;
      lastTouchCenter = center;
    }

    activeTouches = touches;
  }

  function handleTouchEnd(e: TouchEvent): void {
    const remainingTouches = Array.from(e.touches);

    // Handle tap (quick touch without movement)
    if (
      activeTouches.length === 1 &&
      remainingTouches.length === 0 &&
      !hasTouchMoved &&
      Date.now() - touchStartTime < 300
    ) {
      handleClick(touchStartPos.x, touchStartPos.y);
    }

    activeTouches = remainingTouches;
    if (activeTouches.length < 2) {
      lastTouchDist = 0;
    }
    if (activeTouches.length === 1) {
      lastPointerPos = { x: activeTouches[0].clientX, y: activeTouches[0].clientY };
    }
  }

  onMount(() => {
    scene = new Scene(container);
    // Cap pixel ratio on mobile
    scene.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Initialize raycaster for click detection
    raycaster = new THREE.Raycaster();

    // Attach pan/zoom events to the Three.js canvas (it sits on top of the container)
    const canvas = scene.domElement;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('touchcancel', handleTouchEnd);
    // Safari fires non-standard gesture events for a trackpad pinch; suppressing them
    // stops the page from zooming while we handle the ctrl+wheel version.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      canvas.addEventListener(type, (e: Event) => e.preventDefault());
    }

    editorRenderer = new EditorRenderer(scene.scene);
    lightingLayers = createLightingLayers(scene.scene).layers;
    editorRenderer.setModuleLayers(lightingLayers);

    animate();
  });

  onDestroy(() => {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }
    editorRenderer?.dispose();
    for (const layer of lightingLayers) layer.dispose();
    lightingLayers = [];
    scene?.dispose();
  });
</script>

<div class="viewer-canvas" bind:this={container}></div>

<style>
  .viewer-canvas {
    width: 100%;
    height: 100%;
    overflow: hidden;
    touch-action: none;
    cursor: grab;
  }

  .viewer-canvas:active {
    cursor: grabbing;
  }
</style>
