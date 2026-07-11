import type { Knex } from 'knex';

// Assistant settings on the user (ticket 13). Three nullable columns, all user-scoped by living on
// the users row itself:
//   - plan / plan_renews_at: the hosted subscription the Assistant settings screen reads back
//     ($9/mo or $90/yr). Billing (Stripe) is out of scope for this ticket and never writes here yet;
//     a later billing ticket owns setting these. Null everywhere until then → the UI shows the
//     upgrade CTA, which is correct.
//   - assistant_api_key_encrypted: a self-hoster's bring-your-own provider key, stored ENCRYPTED at
//     rest (server/src/crypto/secretBox.ts). Never the plaintext, never returned to the client. Text,
//     because the versioned ciphertext envelope is longer than the raw key.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.string('plan', 32).nullable();
    table.timestamp('plan_renews_at').nullable();
    table.text('assistant_api_key_encrypted').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('assistant_api_key_encrypted');
    table.dropColumn('plan_renews_at');
    table.dropColumn('plan');
  });
}
