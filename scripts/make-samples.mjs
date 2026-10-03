// Generates demo media into dev-samples/ (git-ignored) with FFmpeg.
// The dev server serves that folder, and Help > Load demo media imports it.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = join(import.meta.dirname, '..', 'dev-samples')
mkdirSync(out, { recursive: true })

const jobs = [
  {
    name: 'demo-16x9.mp4',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest'
    ]
  },
  {
    name: 'demo-9x16.mp4',
    args: [
      '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=8',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest'
    ]
  },
  {
    name: 'demo-music.m4a',
    args: [
      '-f', 'lavfi', '-i',
      "aevalsrc=0.25*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))|0.25*sin(2*PI*277*t)*(0.6+0.4*cos(2*PI*0.5*t)):s=48000:d=20",
      '-c:a', 'aac', '-b:a', '160k'
    ]
  },
  {
    name: 'demo-image.png',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=800x800:rate=1', '-frames:v', '1']
  }
]

for (const job of jobs) {
  const target = join(out, job.name)
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...job.args, target], {
    stdio: 'inherit'
  })
  console.log(`created ${target}`)
}
