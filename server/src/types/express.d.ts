// Declaration merge: attach the authenticated user id to Express requests.
// Set by the requireAuth middleware; typed here so no `as any` is ever needed.
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export {};
