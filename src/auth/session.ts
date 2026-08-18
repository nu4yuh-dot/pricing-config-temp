import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from '../data/mongo';
import { type Role } from './roles';
import type { Actor } from '../data/workflow';

const COOKIE = 'dns_pricing_session';
const MAX_AGE_SECONDS = 60 * 60 * 12;

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  createdAt: Date;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters. ' +
        'Generate one with: openssl rand -base64 48',
    );
  }
  return new TextEncoder().encode(value);
}

async function users(): Promise<Collection<UserDoc>> {
  return (await db()).collection<UserDoc>(COLLECTIONS.users);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Verify credentials.
 *
 * Returns the same failure for an unknown email and a wrong password, and always
 * runs a bcrypt comparison, so response timing does not reveal which accounts exist.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = await (await users()).findOne({ email: email.trim().toLowerCase() });
  const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const matches = await bcrypt.compare(password, hash);

  if (!user || !user.active || !matches) return null;
  return { id: user._id.toHexString(), email: user.email, name: user.name, role: user.role };
}

export async function createSession(user: SessionUser): Promise<void> {
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: String(payload.email),
      name: String(payload.name),
      role: payload.role as Role,
    };
  } catch {
    // Expired or tampered token: treat as signed out rather than erroring.
    return null;
  }
}

/** For server actions and pages that must not run anonymously. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new Error('You need to sign in to do that.');
  return user;
}

export function toActor(user: SessionUser): Actor {
  return { id: user.id, email: user.email, name: user.name };
}

export async function listUsers(): Promise<UserDoc[]> {
  return (await users()).find().sort({ email: 1 }).toArray();
}

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: Role;
}): Promise<UserDoc> {
  const doc: UserDoc = {
    _id: new ObjectId(),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    passwordHash: await hashPassword(input.password),
    role: input.role,
    active: true,
    createdAt: new Date(),
  };
  await (await users()).insertOne(doc);
  return doc;
}

export async function setUserRole(userId: string, role: Role): Promise<void> {
  await (await users()).updateOne({ _id: new ObjectId(userId) }, { $set: { role } });
}

export async function setUserActive(userId: string, active: boolean): Promise<void> {
  await (await users()).updateOne({ _id: new ObjectId(userId) }, { $set: { active } });
}
