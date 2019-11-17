import { inject } from '@angular/core';
import { AngularFireAuth } from '@angular/fire/auth';
import { AngularFirestore, AngularFirestoreCollection } from '@angular/fire/firestore';
import { auth, User, firestore } from 'firebase/app';
import 'firebase/auth';
import { switchMap, tap, map } from 'rxjs/operators';
import { Observable, of, combineLatest } from 'rxjs';
import { Store, UpdateStateCallback } from '@datorama/akita';
import { FireAuthState } from './auth.model';
import { WriteOptions } from '../utils/types';

export const fireAuthProviders = ['github', 'google', 'microsoft', 'facebook', 'twitter', 'email', 'apple'] as const;

type FireProvider = (typeof fireAuthProviders)[number];

/** Verify if provider is part of the list of Authentication provider provided by Firebase Auth */
export function isFireAuthProvider(provider: string): provider is FireProvider {
  return fireAuthProviders.includes(provider as any);
}

/**
 * Get the custom claims of a user. If no key is provided, return the whole claims object
 * @param user The user object returned by Firebase Auth
 * @param roles Keys of the custom claims inside the claim objet
 */
export async function getCustomClaims(user: User, roles?: string | string[]): Promise<Record<string, any>> {
  const { claims } = await user.getIdTokenResult();
  if (!roles) {
    return claims;
  }
  const keys = Array.isArray(roles) ? roles : [roles];
  return Object.keys(claims)
    .filter(key => keys.includes(key))
    .reduce((acc, key) => {
      acc[key] = claims[key];
      return acc;
    }, {});
}

/**
 * Get the Authentication Provider based on its name
 * @param provider string literal representing the name of the provider
 */
export function getAuthProvider(provider: FireProvider) {
  switch (provider) {
    case 'email': return new auth.EmailAuthProvider();
    case 'facebook': return new auth.FacebookAuthProvider();
    case 'github': return new auth.GithubAuthProvider();
    case 'google': return new auth.GoogleAuthProvider();
    case 'microsoft': return new auth.OAuthProvider('microsoft.com');
    case 'twitter': return new auth.TwitterAuthProvider();
  }
}

export class FireAuthService<S extends FireAuthState> {

  private collection: AngularFirestoreCollection<S['profile']>;
  protected collectionPath = 'users';
  protected fireAuth: AngularFireAuth;
  protected db: AngularFirestore;
  protected onCreate?(profile: S['profile'], write: WriteOptions): any;
  protected onUpdate?(profile: S['profile'], write: WriteOptions): any;
  protected onDelete?(write: WriteOptions): any;
  /** Triggered when user signin for the first time */
  protected onSignup?(user: auth.UserCredential): any;
  /** Triggered when a user signin, except for the first time @see onSignup */
  protected onSignin?(user: auth.UserCredential): any;

  constructor(
    protected store: Store<S>,
    db?: AngularFirestore,
    fireAuth?: AngularFireAuth
  ) {
    this.db = db || inject(AngularFirestore);
    this.fireAuth = fireAuth || inject(AngularFireAuth);
    this.collection = this.db.collection(this.path);
  }

  get idKey() {
    return this.constructor['idKey'] || 'id';
  }

  /** Can be overrided */
  protected selectProfile(user: User): Observable<S['profile']> {
    return this.collection.doc<S['profile']>(user.uid).valueChanges();
  }

  /** Can be overrided */
  protected selectRoles(user: User): Promise<S['roles']> | Observable<S['roles']> {
    return of(null);
  }

  /**
   * Function triggered when getting data from firestore
   * @note should be overrided
   */
  protected formatFromFirestore<DB>(user: DB): S['profile'] {
    return user;
  }

  /**
   * Function triggered when adding/updating data to firestore
   * @note should be overrided
   */
  protected formatToFirestore<DB>(user: S['profile']): DB {
    return user;
  }

  /**
   * Function triggered when transforming a user into a profile
   * @note Should be override
   */
  protected createProfile(user: User): Promise<Partial<S['profile']>> | Partial<S['profile']> {
    return {
      photoURL: user.photoURL,
      displayName: user.displayName,
    } as any;
  }

  /** The current sign-in user (or null) */
  get user() {
    return this.fireAuth.auth.currentUser;
  }

  /** The path to the profile in firestore */
  get path() {
    return this.constructor['path'] || this.collectionPath;
  }

  /** Start listening on User */
  sync() {
    return this.fireAuth.authState.pipe(
      switchMap((user) => user ? combineLatest([
        of(user.uid),
        this.selectProfile(user),
        this.selectRoles(user),
      ]) : of([null, null, null])),
      tap(([uid, userProfile, roles]) => {
        const profile = this.formatFromFirestore(userProfile);
        this.store.update({ uid, profile, roles } as any);
      }),
      map(([uid, userProfile, roles]) => uid ? [uid, userProfile, roles] : null),
    );
  }

  /**
   * @description Delete user from authentication service and database
   * WARNING This is security sensitive operation
   */
  async delete(options: WriteOptions = {}) {
    if (!this.user) {
      throw new Error('No user connected');
    }
    const { write = this.db.firestore.batch(), ctx } = options;
    const { ref } = this.collection.doc(this.user.uid);
    write.delete(ref);
    if (this.onDelete) {
      await this.onDelete({ write, ctx });
    }
    if (!options.write) {
      await (write as firestore.WriteBatch).commit();
    }
    return this.user.delete();
  }

  /** Update the current profile of the authenticated user */
  async update(
    profile: Partial<S['profile']> | UpdateStateCallback<S['profile']>,
    options: WriteOptions = {}
  ) {
    if (!this.user.uid) {
      throw new Error('No user connected.');
    }
    if (typeof profile === 'function') {
      return this.db.firestore.runTransaction(async tx => {
        const { ref } = this.collection.doc(this.user.uid);
        const snapshot = await tx.get(ref);
        const doc = Object.freeze({ ...snapshot.data(), [this.idKey]: snapshot.id });
        const data = (profile as UpdateStateCallback<S['profile']>)(this.formatFromFirestore(doc));
        tx.update(ref, data);
        if (this.onUpdate) {
          await this.onUpdate(data, { write: tx, ctx: options.ctx });
        }
        return tx;
      });
    } else if (typeof profile === 'object') {
      const { write = this.db.firestore.batch(), ctx } = options;
      const { ref } = this.collection.doc(this.user.uid);
      write.update(ref, this.formatToFirestore(profile));
      if (this.onCreate) {
        await this.onCreate(profile, { write, ctx });
      }
      // If there is no atomic write provided
      if (!options.write) {
        return (write as firestore.WriteBatch).commit();
      }
    }
  }

  /** Create a user based on email and password */
  async signup(email: string, password: string): Promise<auth.UserCredential> {
    const cred = await this.fireAuth.auth.createUserWithEmailAndPassword(email, password);
    if (this.onSignup) {
      this.onSignup(cred);
    }
    const profile = await this.createProfile(cred.user);
    const write = this.db.firestore.batch();
    const { ref } = this.collection.doc(cred.user.uid);
    write.set(ref, this.formatToFirestore(profile));
    if (this.onCreate) {
      await this.onCreate(profile, { write });
    }
    write.commit();
    return cred;
  }

  // tslint:disable-next-line: unified-signatures
  signin(email: string, password: string): Promise<auth.UserCredential>;
  signin(provider?: FireProvider): Promise<auth.UserCredential>;
  signin(token: string): Promise<auth.UserCredential>;
  async signin(provider?: FireProvider | string, password?: string): Promise<auth.UserCredential> {
    this.store.setLoading(true);
    try {
      let cred: auth.UserCredential;
      if (!provider) {
        cred = await this.fireAuth.auth.signInAnonymously();
      } else if (password) {
        cred = await this.fireAuth.auth.signInWithEmailAndPassword(provider, password);
      } else if (isFireAuthProvider(provider)) {
        const authProvider = getAuthProvider(provider);
        cred = await this.fireAuth.auth.signInWithPopup(authProvider);
      } else {
        cred = await this.fireAuth.auth.signInWithCustomToken(provider);
      }
      if (cred.additionalUserInfo.isNewUser) {
        if (this.onSignup) {
          this.onSignup(cred);
        }
        const profile = await this.createProfile(cred.user);
        const write = this.db.firestore.batch();
        const { ref } = this.collection.doc(cred.user.uid);
        write.set(ref, this.formatToFirestore(profile));
        if (this.onCreate) {
          await this.onCreate(profile, { write });
        }
        write.commit();
      } else if (this.onSignin) {
        this.onSignin(cred);
      }
      this.store.setLoading(false);
      return cred;
    } catch (err) {
      this.store.setLoading(false);
      if (err.code === 'auth/operation-not-allowed') {
        console.warn('You tried to connect with unenabled auth provider. Enable it in Firebase console');
      }
      throw err;
    }
  }

  /** Signs out the current user */
  signOut() {
    return this.fireAuth.auth.signOut();
  }
}
