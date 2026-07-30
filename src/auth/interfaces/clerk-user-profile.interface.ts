/**
 * Shape of the `req.user` object attached by ClerkStrategy after a
 * successful JWT verification. Mirrors the UserProfile constructed in
 */
export interface ClerkUserProfile {
    id: string;
    clerkId: string;
    publicMetadata?: {
        role?: string;
        features?: string[];
        isPro?: boolean;
        [key: string]: unknown;
    };
    /** Full decoded JWT payload, kept for debugging/edge cases. */
    rawToken: Record<string, unknown>;
}
