import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  type EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FilePathSource,
  FilePathTarget,
  Input,
  Mp4OutputFormat,
  Output
} from 'mediabunny'

// Joins the video of one file and the sound of another into one MP4 by copying
// their packets (no re-encoding, so no quality loss and no FFmpeg). Used for
// downloads that come as separate video and audio streams.

export async function mergeVideoAudio(videoPath: string, audioPath: string, outPath: string): Promise<void> {
  const videoIn = new Input({ formats: ALL_FORMATS, source: new FilePathSource(videoPath) })
  const audioIn = new Input({ formats: ALL_FORMATS, source: new FilePathSource(audioPath) })
  try {
    const video = await videoIn.getPrimaryVideoTrack()
    const audio = await audioIn.getPrimaryAudioTrack()
    if (!video?.codec || !audio?.codec) throw new Error('The downloaded streams cannot be joined')
    const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(outPath) })
    const videoOut = new EncodedVideoPacketSource(video.codec)
    const audioOut = new EncodedAudioPacketSource(audio.codec)
    output.addVideoTrack(videoOut, { rotation: video.rotation })
    output.addAudioTrack(audioOut)
    await output.start()
    const videoConfig = (await video.getDecoderConfig()) ?? undefined
    const audioConfig = (await audio.getDecoderConfig()) ?? undefined
    const videoPackets = new EncodedPacketSink(video).packets()[Symbol.asyncIterator]()
    const audioPackets = new EncodedPacketSink(audio).packets()[Symbol.asyncIterator]()
    let v: IteratorResult<EncodedPacket> = await videoPackets.next()
    let a: IteratorResult<EncodedPacket> = await audioPackets.next()
    let firstVideo = true
    let firstAudio = true
    // In time order, so the file is interleaved like a normal MP4.
    while (!v.done || !a.done) {
      if (!v.done && (a.done || v.value.timestamp <= a.value.timestamp)) {
        await videoOut.add(v.value, firstVideo ? { decoderConfig: videoConfig } : undefined)
        firstVideo = false
        v = await videoPackets.next()
      } else if (!a.done) {
        await audioOut.add(a.value, firstAudio ? { decoderConfig: audioConfig } : undefined)
        firstAudio = false
        a = await audioPackets.next()
      }
    }
    await output.finalize()
  } finally {
    videoIn.dispose()
    audioIn.dispose()
  }
}
