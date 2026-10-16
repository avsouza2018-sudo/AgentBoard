import type { AppError, Result } from '@agentboard/shared';
import { err, ok, PermissionError } from '@agentboard/shared';
import type { Actor, Role } from '../model/actor.js';

/**
 * Who may put a principal on the board.
 *
 * The rule is not "admins are more powerful than agents". It is that the fleet cannot create its own
 * members. A credential is what makes an actor able to write, and an agent's board role is `agent`,
 * so the power to mint a credential has to sit outside the fleet. Without this rule an agent with
 * write scope could register a second agent with a broader role, and the audit trail would show a
 * card moved by someone who was never granted anything — which is exactly the failure a system whose
 * primary users are autonomous processes has to defend against.
 */
export function canRegisterPrincipal(actor: Actor, roleOnBoard: Role | null): Result<true, AppError> {
  if (roleOnBoard !== 'admin') {
    return err(
      new PermissionError(`only a board admin can register a principal (caller role is '${roleOnBoard ?? 'none'}')`, {
        actorId: actor.id,
        role: roleOnBoard,
        required: 'admin',
      }),
    );
  }

  return ok(true);
}
