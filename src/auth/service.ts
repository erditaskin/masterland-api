import type { Config } from "../config.js";
import { ApiError, ownerLock, type Executor } from "../core.js";
import { issueSession, type Device, type Session } from "../sessions.js";
import type { Identity } from "./providers.js";

/** Provider subject is the sole identity key. Matching emails never link accounts. */
export const signInIdentity = async (
  tx: Executor,
  config: Config,
  identity: Identity,
  previous: Session | null,
  reauthenticate: boolean,
  device?: Device,
) => {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${identity.provider}:${identity.subject}`}, 1))`;
  const [existing] =
    await tx`select user_id from identities where provider=${identity.provider} and subject=${identity.subject}`;
  if (reauthenticate) {
    if (
      !previous ||
      existing?.user_id !== previous.userID ||
      previous.kind !== "registered"
    )
      throw new ApiError("forbidden");
    await ownerLock(tx, previous.userID);
    const updated =
      await tx`update sessions set authenticated_at=now() where id=${previous.id} and user_id=${previous.userID} and expires_at>now() returning id`;
    if (!updated.length) throw new ApiError("unauthenticated");
    return issueSession(tx, previous.userID, config, device);
  }
  const normalizedEmail = identity.email?.trim().toLowerCase() || null;
  let email = normalizedEmail;
  if (!existing && email) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${email}, 2))`;
    const [used] =
      await tx`select id from users where email=${email} and not deleted`;
    if (used) email = null;
  }
  let owner: string;
  if (existing) {
    owner = String(existing.user_id);
    await ownerLock(tx, owner);
    await tx`update users set full_name=coalesce(full_name,${identity.fullName}),provider_email=coalesce(provider_email,${identity.email}) where id=${owner}`;
  } else if (previous?.kind === "guest") {
    await ownerLock(tx, previous.userID);
    const [guest] =
      await tx`select kind from users where id=${previous.userID}`;
    if (guest?.kind !== "guest") throw new ApiError("conflict");
    owner = previous.userID;
    await tx`update users set kind='registered',email=${email},provider_email=${identity.email},full_name=${identity.fullName} where id=${owner}`;
    await tx`insert into identities (provider,subject,user_id) values (${identity.provider},${identity.subject},${owner})`;
    // Guest credentials must not retain registered-account authority after an upgrade.
    await tx`update sessions set revoked_at=now() where user_id=${owner} and revoked_at is null`;
  } else {
    const [created] =
      await tx`insert into users (kind,email,provider_email,full_name) values ('registered',${email},${identity.email},${identity.fullName}) returning id`;
    if (!created) throw new ApiError("internal");
    owner = String(created.id);
    await tx`insert into identities (provider,subject,user_id) values (${identity.provider},${identity.subject},${owner})`;
  }
  return issueSession(tx, owner, config, device);
};
