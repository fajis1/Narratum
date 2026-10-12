'use client';

import { DRAMA_UTTERANCE_TYPES } from '@/lib/shared/drama-director-schema';
import { DRAMA_SPEECH_LABELS, DRAMA_SPEECH_DELIVERIES, type DramaSpeechSettings } from '@/lib/shared/drama-speech-settings';

export function DramaSpeechControls({ value, onChange, disabled = false }: {
  value: DramaSpeechSettings; onChange: (value: DramaSpeechSettings) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="space-y-3">
    <legend className="text-sm font-semibold">Speech type sounds</legend>
    <p className="text-xs text-text-soft">Keep each character’s voice and choose how each kind of speech sounds. Changes apply when recording. Preview a turn to hear the selected treatment.</p>
    {DRAMA_UTTERANCE_TYPES.map(type => {
      const setting = value[type];
      const change = (patch: Partial<typeof setting>) => onChange({ ...value, [type]: { ...setting, ...patch } });
      return <div key={type} className="space-y-2 rounded border border-line-soft p-3">
        <strong className="text-sm">{DRAMA_SPEECH_LABELS[type]}</strong>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs">Sound
            <select aria-label={`${DRAMA_SPEECH_LABELS[type]} sound`} className="block w-full rounded border border-line-soft bg-surface p-2" value={setting.effect} onChange={e => change({ effect: e.target.value as typeof setting.effect })}>
              <option value="clean">Clean voice</option><option value="cb-radio">CB radio</option>
              <option value="mental-link">Mental link</option><option value="inner-voice">Inner voice</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">Delivery
            <select aria-label={`${DRAMA_SPEECH_LABELS[type]} delivery`} className="block w-full rounded border border-line-soft bg-surface p-2" value={setting.delivery} onChange={e => change({ delivery: e.target.value as typeof setting.delivery })}>
              {DRAMA_SPEECH_DELIVERIES.map(delivery => <option key={delivery} value={delivery}>{delivery === 'scene' ? 'Follow the scene' : delivery[0].toUpperCase() + delivery.slice(1)}</option>)}
            </select>
          </label>
        </div>
        {setting.effect !== 'clean' && <label className="block text-xs">Effect strength: {setting.strength}%
          <input aria-label={`${DRAMA_SPEECH_LABELS[type]} effect strength`} className="block w-full" type="range" min="0" max="100" value={setting.strength} onChange={e => change({ strength: Number(e.target.value) })} />
        </label>}
        {setting.effect === 'cb-radio' && <label className="block text-xs">Radio texture
          <select aria-label={`${DRAMA_SPEECH_LABELS[type]} radio texture`} className="block w-full rounded border border-line-soft bg-surface p-2" value={setting.radioTexture} onChange={e => change({ radioTexture: e.target.value as typeof setting.radioTexture })}>
            <option value="none">Voice only</option><option value="static">Light static</option><option value="clicks">Transmission clicks</option><option value="both">Static and clicks</option>
          </select>
        </label>}
      </div>;
    })}
  </fieldset>;
}
