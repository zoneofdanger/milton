/** The native auth migrations, in order. `migrate.ts up --apply` runs each one
 * not yet in `milton_credential.migration_ledger`. */
export const AUTH_MIGRATIONS = [
  "001-native",
  "002-credential",
  "003-mechanism",
  "004-product",
  "005-recovery",
  "006-mail",
  "007-connection-key-status",
];
