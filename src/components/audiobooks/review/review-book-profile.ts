import type { AudiobookGenerationSettings, SmartAudioProfile } from '@/types/client';
import { DRAMA_GEMINI_TTS_WORKER_MODE } from '@/lib/shared/multi-voice';

type BookReviewSettings = Pick<AudiobookGenerationSettings, 'smartAudioProfileId' | 'useSmartAudio'>;
/** A global cleanup preference is not evidence that this book is a drama. */
export function savedBookReviewProfile(profiles: SmartAudioProfile[], settings?: BookReviewSettings | null) {
  if (!settings?.smartAudioProfileId || settings.useSmartAudio === false) return undefined;
  return profiles.find(profile => profile.id === settings.smartAudioProfileId);
}
export function initialReviewCleanupProfile(profiles: SmartAudioProfile[], settings: BookReviewSettings | null, preferredId: string) {
  return profiles.find(profile => profile.id === settings?.smartAudioProfileId && (settings.useSmartAudio !== false || profile.workerMode !== DRAMA_GEMINI_TTS_WORKER_MODE))
    || profiles.find(profile => profile.id === preferredId && profile.workerMode !== DRAMA_GEMINI_TTS_WORKER_MODE)
    || profiles.find(profile => profile.workerMode !== DRAMA_GEMINI_TTS_WORKER_MODE);
}
