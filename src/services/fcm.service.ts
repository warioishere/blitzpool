import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as fs from 'fs';

@Injectable()
export class FcmService implements OnModuleInit {
    private fcmInitialized: boolean = false;

    constructor(private readonly configService: ConfigService) {}

    async onModuleInit(): Promise<void> {
        try {
            const serviceAccountPath = this.configService.get<string>(
                'FCM_SERVICE_ACCOUNT_PATH'
            );

            if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
                const serviceAccount = JSON.parse(
                    fs.readFileSync(serviceAccountPath, 'utf8')
                );

                const appName = 'firebase-blitzpool';

                const existingApp = admin.apps?.find(app => app.name === appName);
                if (!existingApp) {
                    admin.initializeApp({
                        credential: admin.credential.cert(serviceAccount)
                    }, appName);
                }

                this.fcmInitialized = true;
                console.log('[FCM] Initialized successfully');
            } else {
                console.log('[FCM] Not configured, running in mock mode');
            }
        } catch (error: any) {
            console.error(
                '[FCM] Initialization failed:',
                error.message
            );
            console.log('[FCM] Running in mock mode');
        }
    }

    private getFirebaseApp() {
        return admin.app('firebase-blitzpool');
    }

    /**
     * Send a single notification via FCM
     * Returns {success, invalidToken} where invalidToken indicates the token should be deleted
     */
    async sendNotification(
        token: string,
        notification: { title: string; body: string },
        data: Record<string, string>
    ): Promise<{ success: boolean; invalidToken: boolean }> {
        if (!this.fcmInitialized) {
            console.log('[FCM Mock] Would send:', {
                token: token.substring(0, 20) + '...',
                notification,
                data
            });
            return { success: true, invalidToken: false };
        }

        try {
            const message = {
                token,
                notification,
                data,
                android: {
                    priority: 'high' as const,
                    notification: {
                        sound: 'default',
                        channelId: 'blitzpool_notifications'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                            contentAvailable: true
                        }
                    }
                }
            };

            const firebaseApp = this.getFirebaseApp();
            await firebaseApp.messaging().send(message);
            return { success: true, invalidToken: false };
        } catch (error: any) {
            // Invalid tokens should be deleted
            if (
                error.code === 'messaging/invalid-registration-token' ||
                error.code === 'messaging/registration-token-not-registered'
            ) {
                console.log(
                    '[FCM] Invalid token, will be deleted:',
                    token.substring(0, 20) + '...'
                );
                return { success: false, invalidToken: true };
            }

            // Transient errors (network, etc) should be logged but not mark token as invalid
            console.error('[FCM] Send error:', error.code, error.message);
            return { success: false, invalidToken: false };
        }
    }

    /**
     * Send notifications to multiple tokens efficiently
     * Returns success count and list of invalid tokens to delete
     */
    async sendBatchNotifications(
        tokens: string[],
        notification: { title: string; body: string },
        data: Record<string, string>
    ): Promise<{ successCount: number; invalidTokens: string[] }> {
        if (!this.fcmInitialized) {
            console.log(
                '[FCM Mock] Would send batch to',
                tokens.length,
                'tokens'
            );
            return {
                successCount: tokens.length,
                invalidTokens: []
            };
        }

        try {
            const message = {
                notification,
                data,
                android: {
                    priority: 'high' as const,
                    notification: {
                        sound: 'default',
                        channelId: 'blitzpool_notifications'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                            contentAvailable: true
                        }
                    }
                }
            };

            const firebaseApp = this.getFirebaseApp();
            const result = await firebaseApp
                .messaging()
                .sendEachForMulticast({
                    tokens,
                    ...message
                } as any);

            const invalidTokens: string[] = [];

            result.responses.forEach((response, idx) => {
                if (!response.success) {
                    const error = response.error;
                    if (
                        error?.code === 'messaging/invalid-registration-token' ||
                        error?.code === 'messaging/registration-token-not-registered'
                    ) {
                        invalidTokens.push(tokens[idx]);
                    }
                }
            });

            return {
                successCount: result.successCount,
                invalidTokens
            };
        } catch (error: any) {
            console.error('[FCM] Batch send error:', error.code);
            return {
                successCount: 0,
                invalidTokens: []
            };
        }
    }

    /**
     * Validate FCM token format
     * FCM tokens are typically 152-163 characters of alphanumeric + special chars (:_-)
     */
    isValidFcmToken(token: string): boolean {
        return /^[A-Za-z0-9:_-]{152,163}$/.test(token);
    }

    /**
     * Check if FCM is properly initialized
     */
    isInitialized(): boolean {
        return this.fcmInitialized;
    }
}
