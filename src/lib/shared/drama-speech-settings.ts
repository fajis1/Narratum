import { DRAMA_UTTERANCE_TYPES, type DramaUtteranceType } from './drama-director-schema';

export const DRAMA_SPEECH_LABELS: Record<DramaUtteranceType, string> = {
  narration: 'Narration', 'spoken-dialogue': 'Spoken dialogue',
  'internal-thought': 'Internal thought', 'squad-link': 'Squad link',
  'chapter-title': 'Chapter title',
};
export const DRAMA_SOUND_PRESETS = ['clean', 'cb-radio', 'mental-link', 'inner-voice'] as const;
export const DRAMA_SPEECH_DELIVERIES = ['scene', 'soft', 'reflective', 'conversational', 'urgent'] as const;
export const DRAMA_RADIO_TEXTURES = ['none', 'static', 'clicks', 'both'] as const;
export interface DramaSpeechSetting {
  effect: typeof DRAMA_SOUND_PRESETS[number];
  strength: number;
  delivery: typeof DRAMA_SPEECH_DELIVERIES[number];
  radioTexture: typeof DRAMA_RADIO_TEXTURES[number];
}
export type DramaSpeechSettings = Record<DramaUtteranceType, DramaSpeechSetting>;

function member<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : fallback;
}

/** Fresh objects prevent one profile or turn editor from changing another's defaults. */
export function normalizeDramaSpeechSettings(value?: unknown): DramaSpeechSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(DRAMA_UTTERANCE_TYPES.map(type => {
    const raw = source[type] && typeof source[type] === 'object' ? source[type] as Record<string, unknown> : {};
    return [type, {
      effect: member(raw.effect, DRAMA_SOUND_PRESETS, 'clean'),
      strength: typeof raw.strength === 'number' && Number.isFinite(raw.strength) ? Math.round(Math.min(100, Math.max(0, raw.strength))) : 35,
      delivery: member(raw.delivery, DRAMA_SPEECH_DELIVERIES, 'scene'),
      radioTexture: member(raw.radioTexture, DRAMA_RADIO_TEXTURES, 'none'),
    }];
  })) as DramaSpeechSettings;
}

export function dramaSpeechDeliveryHint(type: DramaUtteranceType, settings?: DramaSpeechSettings): string {
  const delivery = settings?.[type]?.delivery ?? 'scene';
  return delivery === 'scene' ? '' : `For ${DRAMA_SPEECH_LABELS[type].toLowerCase()}, use ${delivery} delivery while retaining the character's established voice and scene emotion.`;
}
