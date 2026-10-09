type ErrorCategory = 'drama_director' | 'safety' | 'rate_limit' | 'audio_ffmpeg' | 'general';

interface CategorizedError {
  category: ErrorCategory;
  categoryLabel: string;
  categoryIcon: string;
  explanation: string;
  tips: string[];
}

export function categorizeErrors(errors: string[], jobError?: string | null, hasDirectorDiagnostic = false): CategorizedError {
  const combined = [...errors, jobError || ''].join(' ').toLowerCase();

  if (hasDirectorDiagnostic || combined.includes('segment text does not exactly match') || combined.includes('drama director') || combined.includes('dramadirectorvalidationerror') || combined.includes('secondaryemotions') || combined.includes('director repair attempts exhausted')) {
    return {
      category: 'drama_director',
      categoryLabel: 'Drama Director Validation Failure',
      categoryIcon: '🎭',
      explanation: "Gemini structured acting directions (speaker cues, emotions, tags) did not pass OpenReader's strict schema validator or modified the authoritative source text.",
      tips: [
        'In Smart Audio Settings, switch the Drama Director model to a higher-capacity reasoning model such as Gemini 2.5 Flash or Gemini Pro.',
        'Re-record this chapter from the Audiobook Review Editor.',
        'Inspect the chapter text for unusual quote formatting, nested brackets, or non-standard punctuation that could confuse the Director.',
      ],
    };
  }

  if (combined.includes('prohibited_content') || combined.includes('safety') || combined.includes('blocked')) {
    return {
      category: 'safety',
      categoryLabel: 'Content Safety Filter Block',
      categoryIcon: '🛑',
      explanation: 'Gemini refused to generate speech or directions for this chapter due to upstream cloud content safety policies.',
      tips: [
        'Review and edit this chapter in the Review Editor to adjust sensitive passages.',
        'Alternatively, synthesize this chapter using the local Kokoro TTS profile which operates offline without cloud filters.',
      ],
    };
  }

  if (combined.includes('429') || combined.includes('rate limit') || combined.includes('resource_exhausted') || combined.includes('quota')) {
    return {
      category: 'rate_limit',
      categoryLabel: 'Upstream Quota or Rate Limit',
      categoryIcon: '⏱️',
      explanation: 'The AI or TTS provider temporarily rate limited requests during this chapter.',
      tips: [
        'Wait 30–60 seconds for provider quota to reset, then click Requeue or retry the chapter.',
        'Check your API keys in Smart Audio Settings or ensure adequate tier limits.',
      ],
    };
  }

  if (combined.includes('ffmpeg') || combined.includes('code 234') || combined.includes('audio/mpeg') || combined.includes('concat')) {
    return {
      category: 'audio_ffmpeg',
      categoryLabel: 'Audio Synthesis or Remux Failure',
      categoryIcon: '🔊',
      explanation: 'FFmpeg or the audio encoder encountered an error while synthesizing or concatenating chapter segments.',
      tips: [
        'Re-record this chapter in the Review Editor to regenerate the audio segments.',
        'Verify audio sample rate and export format in Settings.',
      ],
    };
  }

  return {
    category: 'general',
    categoryLabel: 'Chapter Processing Error',
    categoryIcon: '⚠️',
    explanation: 'The chapter encountered an unrecoverable error during TTS processing and has been preserved for manual review.',
    tips: [
      'Open the chapter in the Review Editor to inspect the text and trigger re-recording.',
      'Check if server logs or background workers report connectivity issues.',
    ],
  };
}

/** Structured classification takes precedence over historical English heuristics. */
export function describeAudiobookFailure(failure: { failureCategory?: string; state?: string; retryScheduled?: boolean }, fallback: CategorizedError): CategorizedError {
  if (failure.state === 'recovered_history') return { category: 'general', categoryLabel: 'Recovered historical failure', categoryIcon: '✓', explanation: 'This diagnostic belongs to an earlier attempt. A successful chapter recording is now available.', tips: [] };
  if (failure.failureCategory === 'provider_transient') return { category: 'rate_limit', categoryLabel: 'Provider Temporarily Unavailable', categoryIcon: '⏱️',
    explanation: failure.retryScheduled ? 'The job is waiting for its persisted provider cooldown. Completed recordings and validated text are preserved.' : 'The provider could not complete this request. Check its health and retry missing chapters.',
    tips: failure.retryScheduled ? ['Automatic retry is scheduled; no pronunciation edit is required for this provider failure.'] : ['Check provider health, then use Retry Missing Chapters.'] };
  if (failure.failureCategory === 'provider_configuration') return { category: 'general', categoryLabel: 'Provider Configuration Requires Attention', categoryIcon: '⚙️',
    explanation: 'Provider credentials, access, billing or model configuration prevented this request. Automatic retries have stopped.', tips: ['Correct the provider configuration, then retry missing chapters.'] };
  if (failure.failureCategory === 'technical_unknown') return { category: 'general', categoryLabel: 'Technical Processing Failure', categoryIcon: '⚠️',
    explanation: 'An unexpected technical failure stopped processing. The retained evidence does not establish a pronunciation problem.', tips: ['Inspect the retained diagnostics and server logs before retrying missing chapters.'] };
  return fallback;
}
