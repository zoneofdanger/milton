-- scripts/migrate.ts runs this file and its ledger row in one transaction.
-- Generated from the pinned public native migration planner; reviewed before application.
create schema if not exists "milton_auth";

create table "milton_auth"."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "milton_auth"."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "milton_auth"."user" ("id") on delete cascade);

create table "milton_auth"."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "milton_auth"."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "milton_auth"."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "milton_auth"."jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table "milton_auth"."oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "milton_auth"."user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table "milton_auth"."oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table "milton_auth"."oauthClientResource" ("id" text not null primary key, "clientId" text not null references "milton_auth"."oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "milton_auth"."oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table "milton_auth"."oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "milton_auth"."oauthClient" ("clientId") on delete cascade, "sessionId" text references "milton_auth"."session" ("id") on delete set null, "userId" text not null references "milton_auth"."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "milton_auth"."oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "milton_auth"."oauthClient" ("clientId") on delete cascade, "sessionId" text references "milton_auth"."session" ("id") on delete set null, "userId" text references "milton_auth"."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "milton_auth"."oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "milton_auth"."oauthConsent" ("id" text not null primary key, "clientId" text not null references "milton_auth"."oauthClient" ("clientId") on delete cascade, "userId" text references "milton_auth"."user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "milton_auth"."oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

create table "milton_auth"."rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "milton_auth"."session" ("userId");

create index "account_userId_idx" on "milton_auth"."account" ("userId");

create index "verification_identifier_idx" on "milton_auth"."verification" ("identifier");

create index "oauthClient_userId_idx" on "milton_auth"."oauthClient" ("userId");

create index "oauthClientResource_clientId_idx" on "milton_auth"."oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "milton_auth"."oauthClientResource" ("resourceId");

create index "oauthRefreshToken_clientId_idx" on "milton_auth"."oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "milton_auth"."oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "milton_auth"."oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "milton_auth"."oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "milton_auth"."oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "milton_auth"."oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "milton_auth"."oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "milton_auth"."oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "milton_auth"."oauthAccessToken" ("refreshId");

create index "oauthConsent_clientId_idx" on "milton_auth"."oauthConsent" ("clientId");

create index "oauthConsent_userId_idx" on "milton_auth"."oauthConsent" ("userId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "milton_auth"."oauthClientResource" ("clientId", "resourceId");
