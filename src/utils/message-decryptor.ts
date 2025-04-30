import * as fs from 'fs';
import * as crypto from 'crypto';

function isBase64(str: string): boolean {
    const cleaned = str.trim();
    return /^[A-Za-z0-9+/=]+={0,2}$/.test(cleaned) && cleaned.length % 4 === 0;
}

export function decryptMessageIfNeeded(text: string): string | null {
    if (!isBase64(text) || text.length < 100) {
        return null;
    }

    try {
        const privateKey = fs.readFileSync('/app/keys/private.pem', 'utf8');
        const buffer = Buffer.from(text, 'base64');

        const decrypted = crypto.privateDecrypt(
            {
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
		oaepHash: 'sha256'
            },
            buffer
        );

        return decrypted.toString('utf8');
    } catch (e) {
        console.error("Entschlüsselung fehlgeschlagen:", e.message);
        return null;
    }
}
