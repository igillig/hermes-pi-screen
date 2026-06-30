import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

// ─── Shaders ──────────────────────────────────────────────────────────────────

// Atmosphere rim — defines the sphere boundary regardless of mesh density
const ATMO_VERT = /* glsl */`
varying vec3 vNorm;
void main() {
  vNorm = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const ATMO_FRAG = /* glsl */`
uniform vec3  uColor;
uniform float uOpacity;
varying vec3  vNorm;
void main() {
  float rim = 1.0 - abs(vNorm.z);
  float a   = pow(rim, 1.8) * uOpacity;
  gl_FragColor = vec4(uColor * (0.7 + rim * 0.3), a);
}`

const NODE_VERT = /* glsl */`
attribute float aScale;
attribute float aBright;
varying  float vBright;
void main() {
  vBright = aBright;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aScale * (50.0 / -mv.z);
  gl_Position  = projectionMatrix * mv;
}`

const NODE_FRAG = /* glsl */`
uniform vec3  uColor;
uniform float uOpacity;
uniform float uTime;
varying float vBright;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float flk = 0.90 + 0.10 * sin(uTime * (1.5 + vBright * 5.0));
  float g   = pow(1.0 - d, 1.3) * flk;
  vec3  col = uColor * (0.55 + vBright * 0.45);
  float a   = g * uOpacity * (0.30 + vBright * 0.55);
  gl_FragColor = vec4(col, a);
}`

const SPARK_VERT = /* glsl */`
attribute float aSize;
attribute float aLife;
varying  float vLife;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (50.0 / -mv.z);
  gl_Position  = projectionMatrix * mv;
}`

const SPARK_FRAG = /* glsl */`
uniform vec3  uColor;
varying float vLife;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float g = pow(1.0 - d, 0.8);
  gl_FragColor = vec4(mix(uColor, vec3(1.0), vLife * 0.75), g * vLife * 0.90);
}`

// ─── State configs ────────────────────────────────────────────────────────────

interface Cfg {
  color: THREE.Color; glowOp: number; nodeOp: number; connDim: number
  pulseRate: number; pulseSpeed: number; maxPulses: number
  radius: number; breathAmp: number; breathRate: number; rotY: number; rotX: number
}

const S: Record<OrbState, Cfg> = {
  idle: {
    color: new THREE.Color(0x0099dd), glowOp: 0.25, nodeOp: 0.70, connDim: 0.055,
    pulseRate: 2.5, pulseSpeed: 0.22, maxPulses: 10,
    radius: 1.00, breathAmp: 0.012, breathRate: 0.65, rotY: 0.0014, rotX: 0.0004,
  },
  listening: {
    color: new THREE.Color(0xff2020), glowOp: 0.55, nodeOp: 1.00, connDim: 0.12,
    pulseRate: 14.0, pulseSpeed: 0.58, maxPulses: 40,
    radius: 0.86, breathAmp: 0.07, breathRate: 2.2, rotY: 0.010, rotX: 0.003,
  },
  thinking: {
    color: new THREE.Color(0xffaa00), glowOp: 0.42, nodeOp: 0.88, connDim: 0.09,
    pulseRate: 20.0, pulseSpeed: 0.44, maxPulses: 65,
    radius: 1.06, breathAmp: 0.040, breathRate: 1.3, rotY: 0.003, rotX: 0.006,
  },
  speaking: {
    color: new THREE.Color(0x00ffcc), glowOp: 0.60, nodeOp: 1.00, connDim: 0.09,
    pulseRate: 9.0, pulseSpeed: 0.38, maxPulses: 30,
    radius: 1.12, breathAmp: 0.085, breathRate: 2.8, rotY: 0.004, rotX: 0.001,
  },
}

// ─── Textures ─────────────────────────────────────────────────────────────────

function makeGlowTex(): THREE.CanvasTexture {
  const sz = 256, c = document.createElement('canvas'); c.width = sz; c.height = sz
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2)
  g.addColorStop(0.00, 'rgba(255,255,255,0.45)')
  g.addColorStop(0.30, 'rgba(255,255,255,0.14)')
  g.addColorStop(0.65, 'rgba(255,255,255,0.03)')
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, sz, sz)
  return new THREE.CanvasTexture(c)
}

function makeDotTex(): THREE.CanvasTexture {
  const sz = 32, c = document.createElement('canvas'); c.width = sz; c.height = sz
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2)
  g.addColorStop(0.00, 'rgba(255,255,255,0.90)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.28)')
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, sz, sz)
  return new THREE.CanvasTexture(c)
}

// ─── Network constants ────────────────────────────────────────────────────────
// Nodes fill a sphere volume (not just surface) so the orb looks solid, not hollow.
// Connections are by 3D Euclidean distance between volumetric nodes.

const N_NODES    = 320
const MAX_DIST   = 0.48   // shorter connections → no spiky diagonals across sphere
const MAX_CONN   = 7
const MAX_PULSES = 70

interface Pulse { connIdx: number; a: THREE.Vector3; b: THREE.Vector3; t: number; speed: number; size: number }

export default function NeuralOrb({ state }: { state: OrbState }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<OrbState>(state)
  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    const mount = mountRef.current!
    let W = mount.clientWidth, H = mount.clientHeight
    let raf: number

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(W, H)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100)
    camera.position.z = 3.2

    // ── Volumetric node distribution ──────────────────────────────────
    // Golden spiral for angular placement → guaranteed uniform sphere coverage,
    // no bare patches. Random radius → fills the 3D volume, not a hollow shell.
    const pts: THREE.Vector3[] = []
    const PHI = Math.PI * (1 + Math.sqrt(5))  // golden angle
    for (let i = 0; i < N_NODES; i++) {
      const phi   = Math.acos(1 - 2 * (i + 0.5) / N_NODES)  // uniform latitude
      const theta = i * PHI                                    // golden longitude
      const r     = 0.55 + Math.cbrt(Math.random()) * 0.45   // outer shell only, no deep center
      pts.push(new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      ))
    }

    // ── Connections: nearest 3D Euclidean neighbors ───────────────────
    const connPairs: [THREE.Vector3, THREE.Vector3][] = []
    const seen = new Set<string>()
    for (let i = 0; i < N_NODES; i++) {
      pts
        .map((p, j) => ({ j, d: pts[i].distanceTo(p) }))
        .filter(({ j, d }) => j !== i && d < MAX_DIST)
        .sort((x, y) => x.d - y.d)
        .slice(0, MAX_CONN)
        .forEach(({ j }) => {
          const k = `${Math.min(i,j)}-${Math.max(i,j)}`
          if (seen.has(k)) return
          seen.add(k); connPairs.push([pts[i], pts[j]])
        })
    }
    const NC = connPairs.length

    // ── Connection geometry with per-vertex color (for line brightening) ──
    const cVerts  = new Float32Array(NC * 6)
    const cColors = new Float32Array(NC * 6)
    connPairs.forEach(([a, b], i) => {
      cVerts[i*6]  =a.x; cVerts[i*6+1]=a.y; cVerts[i*6+2]=a.z
      cVerts[i*6+3]=b.x; cVerts[i*6+4]=b.y; cVerts[i*6+5]=b.z
      cColors[i*6]  =0.003; cColors[i*6+1]=0.040; cColors[i*6+2]=0.060
      cColors[i*6+3]=0.003; cColors[i*6+4]=0.040; cColors[i*6+5]=0.060
    })
    const connGeo  = new THREE.BufferGeometry()
    const cColAttr = new THREE.BufferAttribute(cColors, 3)
    connGeo.setAttribute('position', new THREE.BufferAttribute(cVerts,  3))
    connGeo.setAttribute('color',    cColAttr)
    const connMat  = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const connMesh = new THREE.LineSegments(connGeo, connMat)
    connMesh.renderOrder = 1
    const connBright = new Float32Array(NC)

    // ── Node points ───────────────────────────────────────────────────
    const nPos    = new Float32Array(N_NODES * 3)
    const nScale  = new Float32Array(N_NODES)
    const nBright = new Float32Array(N_NODES)
    for (let i = 0; i < N_NODES; i++) {
      nPos[i*3]=pts[i].x; nPos[i*3+1]=pts[i].y; nPos[i*3+2]=pts[i].z
      nScale[i]  = 0.18 + Math.random() * 0.80
      nBright[i] = 0.25 + Math.random() * 0.75
    }
    const nodeGeo = new THREE.BufferGeometry()
    nodeGeo.setAttribute('position', new THREE.BufferAttribute(nPos,    3))
    nodeGeo.setAttribute('aScale',   new THREE.BufferAttribute(nScale,  1))
    nodeGeo.setAttribute('aBright',  new THREE.BufferAttribute(nBright, 1))
    const nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT, fragmentShader: NODE_FRAG,
      uniforms: { uColor: { value: new THREE.Color(0x0099dd) }, uOpacity: { value: 0.70 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    const nodeMesh = new THREE.Points(nodeGeo, nodeMat)
    nodeMesh.renderOrder = 2

    // ── Spark head ────────────────────────────────────────────────────
    const spkPos  = new Float32Array(MAX_PULSES * 3)
    const spkSize = new Float32Array(MAX_PULSES)
    const spkLife = new Float32Array(MAX_PULSES)
    const spkGeo  = new THREE.BufferGeometry()
    const spkPosA  = new THREE.BufferAttribute(spkPos,  3)
    const spkSizeA = new THREE.BufferAttribute(spkSize, 1)
    const spkLifeA = new THREE.BufferAttribute(spkLife, 1)
    spkGeo.setAttribute('position', spkPosA)
    spkGeo.setAttribute('aSize',    spkSizeA)
    spkGeo.setAttribute('aLife',    spkLifeA)
    spkGeo.setDrawRange(0, 0)
    const spkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
      uniforms: { uColor: { value: new THREE.Color(0x0099dd) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    const spkMesh = new THREE.Points(spkGeo, spkMat)
    spkMesh.renderOrder = 3

    // ── Atmosphere rim sphere — defines the circular silhouette ──────
    // This glows only at the edges (fresnel/rim lighting), making the sphere
    // look complete and round even when the internal mesh has sparse areas.
    const atmoGeo = new THREE.SphereGeometry(1.06, 64, 32)
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
      uniforms: { uColor: { value: new THREE.Color(0x0099dd) }, uOpacity: { value: 0.60 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    })
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat)
    atmoMesh.renderOrder = 5

    const net = new THREE.Group()
    net.add(connMesh, nodeMesh, spkMesh, atmoMesh)
    scene.add(net)

    // ── Background ambient field (circular soft dots) ─────────────────
    const BG_N  = 340
    const bgPos = new Float32Array(BG_N * 3)
    for (let i = 0; i < BG_N; i++) {
      const r   = 2.0 + Math.random() * 3.5
      const phi = Math.acos(2 * Math.random() - 1)
      const th  = Math.random() * Math.PI * 2
      bgPos[i*3]  = r * Math.sin(phi) * Math.cos(th)
      bgPos[i*3+1]= r * Math.sin(phi) * Math.sin(th)
      bgPos[i*3+2]= r * Math.cos(phi)
    }
    const bgGeo  = new THREE.BufferGeometry()
    bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3))
    const dotTex = makeDotTex()
    const bgMat  = new THREE.PointsMaterial({
      map: dotTex, alphaTest: 0.01, color: 0x0a1e3a, size: 0.05,
      transparent: true, opacity: 0.50, sizeAttenuation: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
    scene.add(new THREE.Points(bgGeo, bgMat))

    // ── Soft inner glow ───────────────────────────────────────────────
    const glowTex = makeGlowTex()
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex, color: 0x0055aa, transparent: true, opacity: 0.25,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    })
    const glow = new THREE.Sprite(glowMat)
    glow.scale.setScalar(3.2); glow.renderOrder = -2
    scene.add(glow)

    // ── Speaking rings ────────────────────────────────────────────────
    interface WRing { mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>; age: number }
    const wRings: WRing[] = []
    const wGeo   = new THREE.TorusGeometry(0.85, 0.003, 6, 80)
    const wTimer = setInterval(() => {
      if (stateRef.current !== 'speaking') return
      const m = new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false })
      const mesh = new THREE.Mesh(wGeo, m)
      mesh.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI)
      mesh.renderOrder = 4; scene.add(mesh); wRings.push({ mesh, age: 0 })
    }, 520)

    // ── Lerp state ────────────────────────────────────────────────────
    const pulses: Pulse[] = []
    let spawnAcc = 0, lRadius = S.idle.radius, lGlowOp = S.idle.glowOp
    let lNodeOp = S.idle.nodeOp, lConnDim = S.idle.connDim
    const lColor = new THREE.Color(0x0099dd)
    const tmpV   = new THREE.Vector3()

    const onResize = () => {
      W = mount.clientWidth; H = mount.clientHeight
      renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    const clock = new THREE.Clock(); let prevT = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const t  = clock.getElapsedTime()
      const dt = Math.min(t - prevT, 0.05); prevT = t

      const cfg = S[stateRef.current]
      const k   = 1 - Math.pow(0.05, dt)

      lRadius  += (cfg.radius  - lRadius)  * k
      lGlowOp  += (cfg.glowOp  - lGlowOp)  * k
      lNodeOp  += (cfg.nodeOp  - lNodeOp)  * k
      lConnDim += (cfg.connDim - lConnDim)  * k
      lColor.lerp(cfg.color, k)

      const sc = lRadius * (1 + Math.sin(t * cfg.breathRate) * cfg.breathAmp)
      net.rotation.y += cfg.rotY * dt * 60
      net.rotation.x += cfg.rotX * dt * 60
      net.scale.setScalar(sc)

      bgMat.color.copy(lColor).multiplyScalar(0.18)
      nodeMat.uniforms.uColor.value.copy(lColor)
      nodeMat.uniforms.uOpacity.value = lNodeOp
      nodeMat.uniforms.uTime.value    = t
      spkMat.uniforms.uColor.value.copy(lColor)
      atmoMat.uniforms.uColor.value.copy(lColor)
      atmoMat.uniforms.uOpacity.value = 0.45 + lGlowOp * 0.45
      glowMat.color.copy(lColor); glowMat.opacity = lGlowOp

      // Spawn pulses
      if (pulses.length < cfg.maxPulses) {
        spawnAcc += cfg.pulseRate * dt
        while (spawnAcc >= 1 && pulses.length < cfg.maxPulses) {
          spawnAcc -= 1
          const idx    = Math.floor(Math.random() * NC)
          const [a, b] = connPairs[idx]
          pulses.push({ connIdx: idx, a, b, t: 0, speed: cfg.pulseSpeed * (0.5 + Math.random() * 1.0), size: 0.25 + Math.random() * 0.50 })
        }
      } else { spawnAcc = 0 }

      // Decay connection brightness
      for (let i = 0; i < NC; i++) connBright[i] = Math.max(0, connBright[i] - dt * 3.5)

      // Advance pulses
      let cnt = 0
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]
        p.t += p.speed * dt
        if (p.t >= 1) { pulses.splice(i, 1); continue }

        connBright[p.connIdx] = 1.0   // line lights up = current flowing

        tmpV.lerpVectors(p.a, p.b, p.t)
        spkPos[cnt*3]=tmpV.x; spkPos[cnt*3+1]=tmpV.y; spkPos[cnt*3+2]=tmpV.z
        spkSize[cnt] = p.size
        spkLife[cnt] = Math.sin(p.t * Math.PI)
        cnt++
      }
      spkPosA.needsUpdate = true; spkSizeA.needsUpdate = true; spkLifeA.needsUpdate = true
      spkGeo.setDrawRange(0, cnt)

      // Update line vertex colors
      const dr = lColor.r, dg = lColor.g, db = lColor.b
      for (let i = 0; i < NC; i++) {
        const bv = lConnDim + connBright[i] * (1.0 - lConnDim)
        const r = dr*bv, g = dg*bv, bl = db*bv
        cColors[i*6]  =r; cColors[i*6+1]=g; cColors[i*6+2]=bl
        cColors[i*6+3]=r; cColors[i*6+4]=g; cColors[i*6+5]=bl
      }
      cColAttr.needsUpdate = true

      // Wave rings
      for (let i = wRings.length - 1; i >= 0; i--) {
        const w = wRings[i]
        w.age += dt
        w.mesh.scale.setScalar(sc * (1 + w.age * 2.0))
        w.mesh.material.color.copy(lColor)
        w.mesh.material.opacity = Math.max(0, 0.38 - w.age * 0.40)
        if (w.age > 1) { scene.remove(w.mesh); wRings.splice(i, 1) }
      }

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(wTimer)
      window.removeEventListener('resize', onResize)
      wRings.forEach(w => scene.remove(w.mesh))
      wGeo.dispose(); atmoGeo.dispose(); glowTex.dispose(); dotTex.dispose(); renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%' }} />
}
