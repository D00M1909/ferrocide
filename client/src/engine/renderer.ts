// Low-resolution render pipeline: world + viewmodel are drawn into a small render
// target, then upscaled with nearest filtering through a post shader that adds
// ordered dithering, colour quantisation, vignette and full-screen flashes.
import * as THREE from 'three';
import { psxUniforms } from './psx';

export interface PostState {
  flash: THREE.Color;
  flashAmount: number;
  hurt: number; // red vignette 0..1
  lowHp: number; // pulsing edge 0..1
  saturation: number;
  dither: boolean;
}

export class RetroRenderer {
  readonly gl: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.ShaderMaterial;
  internalHeight = 360;
  readonly post: PostState = {
    flash: new THREE.Color(1, 1, 1),
    flashAmount: 0,
    hurt: 0,
    lowHp: 0,
    saturation: 1.0,
    dither: true,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.gl.setPixelRatio(1);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.autoClear = false;
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      type: THREE.HalfFloatType,
    });
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.target.texture },
        uRes: { value: new THREE.Vector2(4, 4) },
        uFlash: { value: new THREE.Color() },
        uFlashAmt: { value: 0 },
        uHurt: { value: 0 },
        uLow: { value: 0 },
        uSat: { value: 1 },
        uDither: { value: 1 },
        uTime: psxUniforms.uTime,
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tScene; uniform vec2 uRes; uniform vec3 uFlash; uniform float uFlashAmt;
        uniform float uHurt; uniform float uLow; uniform float uSat; uniform float uDither; uniform float uTime;
        varying vec2 vUv;
        float bayer(vec2 p){
          int x = int(mod(p.x, 4.0)); int y = int(mod(p.y, 4.0));
          int i = x + y * 4;
          float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
          for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.5;
          return 0.0;
        }
        void main(){
          vec3 c = texture2D(tScene, vUv).rgb;
          // linear -> display
          c = pow(max(c, 0.0), vec3(1.0/2.2));
          float l = dot(c, vec3(0.299,0.587,0.114));
          c = mix(vec3(l), c, uSat);
          // quantise to a 5-bit-per-channel palette with ordered dither
          vec2 px = floor(vUv * uRes);
          float levels = 31.0;
          c += bayer(px) * uDither / levels;
          c = floor(c * levels + 0.5) / levels;
          // vignette + damage
          vec2 d = vUv - 0.5;
          float vig = smoothstep(0.85, 0.25, length(d * vec2(1.25, 1.0)));
          c *= mix(0.55, 1.0, vig);
          float edge = 1.0 - vig;
          c = mix(c, vec3(0.8, 0.0, 0.02), clamp(edge * (uHurt * 1.6 + uLow * (0.55 + 0.45 * sin(uTime * 6.0))), 0.0, 0.85));
          c = mix(c, uFlash, clamp(uFlashAmt, 0.0, 1.0));
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    const ih = this.internalHeight > 0 ? Math.min(this.internalHeight, h) : h;
    const iw = Math.round((ih * w) / h);
    this.target.setSize(iw, ih);
    this.postMat.uniforms.uRes.value.set(iw, ih);
    psxUniforms.uSnap.value.set(iw / 2, ih / 2);
  }

  get aspect(): number {
    return window.innerWidth / window.innerHeight;
  }

  render(world: THREE.Scene, cam: THREE.PerspectiveCamera, viewmodel: THREE.Scene | null, vmCam: THREE.PerspectiveCamera | null): void {
    const g = this.gl;
    g.setRenderTarget(this.target);
    g.setClearColor(0x000000, 1);
    g.clear(true, true, true);
    g.render(world, cam);
    if (viewmodel && vmCam) {
      g.clearDepth();
      g.render(viewmodel, vmCam);
    }
    g.setRenderTarget(null);
    const u = this.postMat.uniforms;
    u.uFlash.value.copy(this.post.flash);
    u.uFlashAmt.value = this.post.flashAmount;
    u.uHurt.value = this.post.hurt;
    u.uLow.value = this.post.lowHp;
    u.uSat.value = this.post.saturation;
    u.uDither.value = this.post.dither ? 1 : 0;
    g.clear(true, true, true);
    g.render(this.postScene, this.postCam);
  }
}
