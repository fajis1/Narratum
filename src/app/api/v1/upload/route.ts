import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db';
import { userApiKeys, documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { putDocumentBlob } from '@/lib/server/documents/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate Request
    const authHeader = req.headers.get('authorization');
    let userId: string | null = null;
    let apiKeyRecordId: string | null = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      // First check DB user API keys
      const [keyRecord] = await db
        .select()
        .from(userApiKeys)
        .where(eq(userApiKeys.keyHash, tokenHash))
        .limit(1);

      if (keyRecord) {
        if (keyRecord.expiresAt && Number(keyRecord.expiresAt) < Date.now()) {
          return NextResponse.json({ error: 'API key has expired' }, { status: 401 });
        }
        userId = keyRecord.userId;
        apiKeyRecordId = keyRecord.id;
      } else if (process.env.OPENREADER_API_KEY && token === process.env.OPENREADER_API_KEY) {
        // Fallback to single global OPENREADER_API_KEY from .env if defined
        userId = 'system_admin';
      }
    }

    if (!userId) {
      return NextResponse.json(
        { error: 'Missing or invalid Authorization header. Expected Bearer token.' },
        { status: 401 }
      );
    }

    // 2. Extract Form Data
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const title = (formData.get('title') as string | null) || (file ? file.name : 'Untitled Document');

    if (!file) {
      return NextResponse.json({ error: 'No file provided in form data field "file"' }, { status: 400 });
    }

    // 3. Process File & Store Blob
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileExt = file.name.split('.').pop()?.toLowerCase() || 'pdf';
    const documentId = crypto.createHash('sha256').update(buffer).digest('hex');

    const namespace = getOpenReaderTestNamespace(req.headers);

    // Store in docstore (S3 / SeaweedFS / local filesystem based on OpenReader config)
    await putDocumentBlob(documentId, buffer, file.type || 'application/octet-stream', namespace);

    // 4. Insert Document into Database
    const now = Date.now();
    await db.insert(documents).values({
      id: documentId,
      userId,
      name: title,
      type: fileExt,
      size: file.size,
      lastModified: now,
      filePath: documentId,
      createdAt: now,
    } as any).onConflictDoNothing();

    // 5. Update lastUsedAt timestamp on API key if applicable
    if (apiKeyRecordId) {
      db.update(userApiKeys)
        .set({ lastUsedAt: now })
        .where(eq(userApiKeys.id, apiKeyRecordId))
        .catch((err: any) => console.warn('Failed to update API key lastUsedAt:', err));
    }

    return NextResponse.json({
      success: true,
      documentId,
      title,
      type: fileExt,
      size: file.size,
      status: 'queued',
      message: 'Document successfully uploaded and queued for OpenReader processing.',
    });
  } catch (error: any) {
    console.error('Upload API Endpoint Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error during document upload' },
      { status: 500 }
    );
  }
}
