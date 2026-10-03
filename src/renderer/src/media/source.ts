import { BlobSource, UrlSource, type Source } from 'mediabunny'
import type { MediaItem } from '../core/types'
import { isElectron, mediaPathUrl } from '../platform'

/** Where Mediabunny reads a media item from: the imported File, or its path (Electron). */
export function inputSource(media: MediaItem): Source {
  if (media.file) return new BlobSource(media.file)
  if (media.path && isElectron) return new UrlSource(mediaPathUrl(media.path))
  throw new Error('file not available — re-import it to relink')
}

export function canRead(media: MediaItem): boolean {
  return media.file !== null || (media.path !== '' && isElectron)
}
