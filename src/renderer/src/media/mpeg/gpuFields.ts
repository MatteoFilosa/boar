import type { InterlacedFrame, Plane } from './deinterlace'

// The graphics card's version of deinterlace.ts and resample.ts (WebGL2, any
// vendor): the same field interpolation, then lines stretched to square
// pixels and turned into RGB, drawn into a canvas that becomes the encoder's
// frame. Several times faster than the processor, which keeps decoding.

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/** Interpolates the lines of parity `missing` (-1: none, a progressive frame) like deinterlacePlane. */
const DEINTERLACE = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D cur;
uniform highp sampler2D before;
uniform highp sampler2D after;
uniform highp sampler2D prev;
uniform highp sampler2D next;
uniform int missing;
uniform ivec2 size;
out vec4 color;

int at(highp sampler2D t, int x, int y) {
  return int(texelFetch(t, ivec2(clamp(x, 0, size.x - 1), clamp(y, 0, size.y - 1)), 0).r * 255.0 + 0.5);
}

void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y);
  if ((y & 1) != missing) {
    color = vec4(float(at(cur, x, y)) / 255.0, 0.0, 0.0, 1.0);
    return;
  }
  int up = y - 1 >= 0 ? y - 1 : y + 1;
  int down = y + 1 < size.y ? y + 1 : y - 1;
  int up2 = y - 2 >= 0 ? y - 2 : y;
  int down2 = y + 2 < size.y ? y + 2 : y;
  int c = at(cur, x, up);
  int e = at(cur, x, down);
  int pb = at(before, x, y);
  int pa = at(after, x, y);
  int d = (pb + pa) >> 1;
  int diff = max(abs(pb - pa) >> 1, max(
    (abs(at(prev, x, up) - c) + abs(at(prev, x, down) - e)) >> 1,
    (abs(at(next, x, up) - c) + abs(at(next, x, down) - e)) >> 1));
  int pred = (c + e) >> 1;
  if (x >= 3 && x < size.x - 3) {
    #define C(i) at(cur, x + (i), up)
    #define E(i) at(cur, x + (i), down)
    int score = abs(C(-1) - E(-1)) + abs(c - e) + abs(C(1) - E(1)) - 1;
    int s = abs(C(-2) - E(0)) + abs(C(-1) - E(1)) + abs(C(0) - E(2));
    if (s < score) {
      score = s;
      pred = (C(-1) + E(1)) >> 1;
      s = abs(C(-3) - E(1)) + abs(C(-2) - E(2)) + abs(C(-1) - E(3));
      if (s < score) {
        score = s;
        pred = (C(-2) + E(2)) >> 1;
      }
    }
    s = abs(C(0) - E(-2)) + abs(C(1) - E(-1)) + abs(C(2) - E(0));
    if (s < score) {
      score = s;
      pred = (C(1) + E(-1)) >> 1;
      s = abs(C(1) - E(-3)) + abs(C(2) - E(-2)) + abs(C(3) - E(-1));
      if (s < score) pred = (C(2) + E(-2)) >> 1;
    }
  }
  if (y != 0 && y != size.y - 1) {
    int b = (at(before, x, up2) + at(after, x, up2)) >> 1;
    int f = (at(before, x, down2) + at(after, x, down2)) >> 1;
    int most = max(max(d - e, d - c), min(b - c, f - e));
    int least = min(min(d - e, d - c), max(b - c, f - e));
    diff = max(max(diff, least), -most);
  }
  pred = clamp(clamp(pred, d - diff, d + diff), 0, 255);
  color = vec4(float(pred) / 255.0, 0.0, 0.0, 1.0);
}`

/** Square pixels (bicubic across, lines as they are) and BT.601 studio range YUV to RGB. */
const OUTPUT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D luma;
uniform highp sampler2D cb;
uniform highp sampler2D cr;
uniform ivec2 src;
uniform ivec2 dst;
out vec4 color;

float lumaAt(int x, int y) {
  return texelFetch(luma, ivec2(clamp(x, 0, src.x - 1), y), 0).r;
}

float chromaAt(highp sampler2D t, int x, int y) {
  ivec2 size = src / 2;
  return texelFetch(t, ivec2(clamp(x, 0, size.x - 1), clamp(y, 0, size.y - 1)), 0).r;
}

float bilinear(highp sampler2D t, float x, float y) {
  int x0 = int(floor(x));
  int y0 = int(floor(y));
  float fx = x - floor(x);
  float fy = y - floor(y);
  return mix(
    mix(chromaAt(t, x0, y0), chromaAt(t, x0 + 1, y0), fx),
    mix(chromaAt(t, x0, y0 + 1), chromaAt(t, x0 + 1, y0 + 1), fx),
    fy);
}

void main() {
  int ox = int(gl_FragCoord.x);
  // Canvas rows count from the bottom; picture lines from the top.
  int oy = dst.y - 1 - int(gl_FragCoord.y);
  int sy = int((float(oy) + 0.5) * float(src.y) / float(dst.y));
  float sx = (float(ox) + 0.5) * float(src.x) / float(dst.x) - 0.5;
  int ix = int(floor(sx));
  float t = sx - float(ix);
  float a = lumaAt(ix - 1, sy);
  float b = lumaAt(ix, sy);
  float c = lumaAt(ix + 1, sy);
  float d = lumaAt(ix + 2, sy);
  float y = 0.5 * (2.0 * b + (c - a) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t * t + (3.0 * (b - c) + d - a) * t * t * t);
  // MPEG chroma sits on every other sample across and between lines down.
  float cx = sx / 2.0;
  float cy = (float(sy) - 0.5) / 2.0;
  float u = bilinear(cb, cx, cy) - 128.0 / 255.0;
  float v = bilinear(cr, cx, cy) - 128.0 / 255.0;
  float l = (y - 16.0 / 255.0) * 1.164384;
  color = vec4(clamp(vec3(l + 1.596027 * v, l - 0.391762 * u - 0.812968 * v, l + 2.017232 * u), 0.0, 1.0), 1.0);
}`

interface PlaneTextures {
  y: WebGLTexture
  u: WebGLTexture
  v: WebGLTexture
}

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, fragment]
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('WebGL shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program')
  return program
}

export class GpuFields {
  readonly canvas: OffscreenCanvas
  private gl: WebGL2RenderingContext
  private deinterlace: WebGLProgram
  private output: WebGLProgram
  /** Three decoded frames (previous, current, next), reused in turn. */
  private slots: PlaneTextures[]
  /** The whole frame made from one field, before it is stretched. */
  private whole: PlaneTextures
  private framebuffers: WebGLFramebuffer[]
  private width: number
  private height: number

  /** Null where WebGL2 is missing in workers: the processor does it then. */
  static create(width: number, height: number, outWidth: number, outHeight: number): GpuFields | null {
    try {
      if (typeof OffscreenCanvas === 'undefined') return null
      const canvas = new OffscreenCanvas(outWidth, outHeight)
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false, preserveDrawingBuffer: true })
      if (!gl) return null
      return new GpuFields(canvas, gl, width, height)
    } catch {
      return null
    }
  }

  private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext, width: number, height: number) {
    this.canvas = canvas
    this.gl = gl
    this.width = width
    this.height = height
    this.deinterlace = compile(gl, DEINTERLACE)
    this.output = compile(gl, OUTPUT)
    const planes = (): PlaneTextures => ({
      y: this.texture(width, height),
      u: this.texture(width >> 1, height >> 1),
      v: this.texture(width >> 1, height >> 1)
    })
    this.slots = [planes(), planes(), planes()]
    this.whole = planes()
    this.framebuffers = [this.whole.y, this.whole.u, this.whole.v].map((texture) => {
      const fb = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      return fb
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  }

  private texture(width: number, height: number): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    return texture
  }

  /** Puts a decoded frame in slot 0, 1 or 2. */
  upload(slot: number, frame: InterlacedFrame): void {
    const gl = this.gl
    const put = (texture: WebGLTexture, plane: Plane, width: number, height: number): void => {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, plane.stride)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, plane.data, plane.offset)
    }
    const t = this.slots[slot]
    put(t.y, frame.y, this.width, this.height)
    put(t.u, frame.u, this.width >> 1, this.height >> 1)
    put(t.v, frame.v, this.width >> 1, this.height >> 1)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
  }

  /**
   * Draws into the canvas the frame made from one field of slot `cur`
   * (`missing` = parity of the lines to fill, -1 for a progressive frame),
   * with `before`/`after` holding those lines just before and after it.
   */
  draw(cur: number, before: number, after: number, prev: number, next: number, missing: number): void {
    const gl = this.gl
    const s = this.slots
    gl.useProgram(this.deinterlace)
    const sampler = (name: string, unit: number, texture: WebGLTexture): void => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(gl.getUniformLocation(this.deinterlace, name), unit)
    }
    const planes = ['y', 'u', 'v'] as const
    planes.forEach((plane, i) => {
      const width = i === 0 ? this.width : this.width >> 1
      const height = i === 0 ? this.height : this.height >> 1
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[i])
      gl.viewport(0, 0, width, height)
      sampler('cur', 0, s[cur][plane])
      sampler('before', 1, s[before][plane])
      sampler('after', 2, s[after][plane])
      sampler('prev', 3, s[prev][plane])
      sampler('next', 4, s[next][plane])
      gl.uniform1i(gl.getUniformLocation(this.deinterlace, 'missing'), missing)
      gl.uniform2i(gl.getUniformLocation(this.deinterlace, 'size'), width, height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.output)
    planes.forEach((plane, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.whole[plane])
      gl.uniform1i(gl.getUniformLocation(this.output, ['luma', 'cb', 'cr'][i]), i)
    })
    gl.uniform2i(gl.getUniformLocation(this.output, 'src'), this.width, this.height)
    gl.uniform2i(gl.getUniformLocation(this.output, 'dst'), this.canvas.width, this.canvas.height)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
