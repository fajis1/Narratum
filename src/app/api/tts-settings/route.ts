import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

import {
  getDefaultSmartAudioProfile,
  mergeStoredSmartAudioProfileSecrets,
  readSmartAudioProfilesDocument,
  readPronunciationModelUpgradeOffer,
  redactSmartAudioProfileSecrets,
  redactSmartAudioProfilesDocument,
  restoreMissingBuiltInSmartAudioProfilesForUser,
  savePronunciationModelUpgradeDecision,
  writeSmartAudioProfilesDocument,
} from '@/lib/server/smart-audio-profiles';
import type { SmartAudioProfile } from '@/types/client';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { parseServiceAccountJson } from '@/lib/server/smart-audio/google-cloud-auth';

export const dynamic = 'force-dynamic';

const configDir = path.join(process.cwd(), 'config');

// --- GET: Fetch profiles with key status metadata, never stored key values ---
export async function GET(request: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId;

    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);

    const profilesDocument = redactSmartAudioProfilesDocument(
      await readSmartAudioProfilesDocument(userId),
    );
    const pronunciationModelUpgrade = await readPronunciationModelUpgradeOffer(userId);

    return NextResponse.json({
      smartAudioProfiles: profilesDocument.profiles,
      selectedSmartAudioProfileId: profilesDocument.selectedProfileId,
      defaultSmartAudioProfileId: getDefaultSmartAudioProfile().id,
      pronunciationModelUpgrade,
    });
  } catch (error) {
    serverLogger.warn({ event: 'tts_settings.read.failed', error }, 'Error reading smart audio settings');
    const defaultProfile = getDefaultSmartAudioProfile();
    return NextResponse.json({
      smartAudioProfiles: [redactSmartAudioProfileSecrets(defaultProfile)],
      selectedSmartAudioProfileId: defaultProfile.id,
      defaultSmartAudioProfileId: defaultProfile.id,
    });
  }
}

// --- POST: Save book settings and update global key ---
export async function POST(request: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId;
    const body = await request.json();

    if (body.pronunciationModelUpgradeDecision === 'upgrade'
      || body.pronunciationModelUpgradeDecision === 'stay') {
      const pronunciationModelUpgrade = await savePronunciationModelUpgradeDecision(
        userId,
        body.pronunciationModelUpgradeDecision,
      );
      serverLogger.info({
        event: 'tts_settings.pronunciation_model_upgrade_decided',
        decision: body.pronunciationModelUpgradeDecision,
        affectedProfileCount: pronunciationModelUpgrade.affectedProfileCount,
      }, 'Saved pronunciation model upgrade decision');
      return NextResponse.json({ success: true, pronunciationModelUpgrade });
    }

    const currentDoc = await readSmartAudioProfilesDocument(userId);
    let savedDoc = currentDoc;
    let restoredProfiles: Array<{ id: string; name: string }> = [];

    if (body.restoreMissingBuiltInProfiles === true) {
      const restored = await restoreMissingBuiltInSmartAudioProfilesForUser(userId);
      savedDoc = restored.document;
      restoredProfiles = restored.restoredProfiles;
    } else if (Array.isArray(body.smartAudioProfiles)) {
      const selectedSmartAudioProfileId = typeof body.selectedSmartAudioProfileId === 'string'
        ? body.selectedSmartAudioProfileId
        : undefined;
      const incomingProfiles = body.smartAudioProfiles as SmartAudioProfile[];
      for (const profile of incomingProfiles) {
        if (!profile.googleCloudServiceAccountJson?.trim()) continue;
        try {
          parseServiceAccountJson(profile.googleCloudServiceAccountJson);
        } catch {
          return NextResponse.json({ error: 'Invalid Google Cloud service-account JSON.' }, { status: 400 });
        }
      }
      const removeCloudCredentialIds = new Set(
        Array.isArray(body.removeGoogleCloudServiceAccountProfileIds)
          ? body.removeGoogleCloudServiceAccountProfileIds.filter((id: unknown): id is string => typeof id === 'string')
          : [],
      );
      const mergedProfiles = mergeStoredSmartAudioProfileSecrets(incomingProfiles, currentDoc.profiles)
        .map((profile) => removeCloudCredentialIds.has(profile.id)
          ? { ...profile, googleCloudServiceAccountJson: undefined, googleCloudServiceAccountConfigured: false, googleCloudServiceAccountEmail: null }
          : profile);
      savedDoc = await writeSmartAudioProfilesDocument(userId, {
        selectedProfileId: selectedSmartAudioProfileId || currentDoc.selectedProfileId,
        profiles: mergedProfiles,
      });
    }

    serverLogger.info({
      event: 'tts_settings.saved',
      restoredBuiltInProfileIds: restoredProfiles.map((profile) => profile.id),
    }, 'Saved smart audio settings');
    const safeDocument = redactSmartAudioProfilesDocument(savedDoc);
    return NextResponse.json({
      success: true,
      message: 'Settings saved.',
      smartAudioProfiles: safeDocument.profiles,
      selectedSmartAudioProfileId: safeDocument.selectedProfileId,
      defaultSmartAudioProfileId: getDefaultSmartAudioProfile().id,
      restoredProfiles,
    });
  } catch (error) {
    serverLogger.error({ event: 'tts_settings.save.failed', error }, 'Error processing smart audio settings');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to save smart audio settings',
      normalize: { code: 'SMART_AUDIO_SETTINGS_SAVE_FAILED', errorClass: 'db' },
    });
  }
}
