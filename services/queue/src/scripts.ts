/**
 * Scripts Lua: cada operación que toca varias claves de un evento es atómica (ADR-06). Todas las
 * claves de un evento llevan el hash tag `{eventId}` (mismo slot si se usa Redis Cluster); las
 * claves de turno se arman dentro del script con el prefijo recibido.
 */

/**
 * KEYS: seq, waiting, prequeue, turn, opened, events
 * ARGV: userId, now, prequeuePhase (1|0), eventId, turnTtlMs
 * → { created (1|0), state, seq }
 */
export const JOIN = `
local state = redis.call('HGET', KEYS[4], 'state')
if state == 'WAITING' or state == 'PREQUEUE' or state == 'ADMITTED' then
  redis.call('HSET', KEYS[4], 'lastSeen', ARGV[2])
  return {0, state, redis.call('HGET', KEYS[4], 'seq')}
end
local seq = redis.call('INCR', KEYS[1])
local newState = 'WAITING'
if ARGV[3] == '1' and redis.call('EXISTS', KEYS[5]) == 0 then
  redis.call('SADD', KEYS[3], ARGV[1])
  newState = 'PREQUEUE'
else
  redis.call('ZADD', KEYS[2], seq, ARGV[1])
end
redis.call('DEL', KEYS[4])
redis.call('HSET', KEYS[4], 'state', newState, 'seq', seq, 'joinedAt', ARGV[2], 'lastSeen', ARGV[2])
redis.call('PEXPIRE', KEYS[4], ARGV[5])
redis.call('SADD', KEYS[6], ARGV[4])
return {1, newState, tostring(seq)}
`;

/**
 * KEYS: waiting, prequeue, active, turn
 * ARGV: userId, now, prefix (q:{e}:), finalState (LEFT|COMPLETED)
 * → { previousState, jti }
 */
export const FINISH = `
local state = redis.call('HGET', KEYS[4], 'state')
if not state then return {false, false} end
local jti = redis.call('HGET', KEYS[4], 'jti')
if ARGV[4] == 'COMPLETED' and state ~= 'ADMITTED' then return {state, false} end
if state ~= 'WAITING' and state ~= 'PREQUEUE' and state ~= 'ADMITTED' then return {state, false} end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
if jti then redis.call('DEL', ARGV[3] .. 'jti:' .. jti) end
redis.call('HSET', KEYS[4], 'state', ARGV[4], 'finishedAt', ARGV[2])
return {state, jti or false}
`;

/**
 * Admisión de un tick (solo la réplica líder). Primero vence ventanas, luego admite hasta llenar los
 * cupos libres, saltando a quienes dejaron de consultar (abandono).
 *
 * KEYS: waiting, active, paused
 * ARGV: now, slots, batchMax, windowMs, heartbeatCutoff, prefix, jti_1 … jti_n
 * → { expired = {uid, jti, …}, admitted = {uid, jti, expiresAt, …}, abandoned }
 */
export const ADMIT = `
local now = tonumber(ARGV[1])
local prefix = ARGV[6]
local expired = {}
local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, uid in ipairs(due) do
  redis.call('ZREM', KEYS[2], uid)
  local turn = prefix .. 'turn:' .. uid
  local jti = redis.call('HGET', turn, 'jti')
  if jti then redis.call('DEL', prefix .. 'jti:' .. jti) end
  if redis.call('HGET', turn, 'state') == 'ADMITTED' then
    redis.call('HSET', turn, 'state', 'EXPIRED', 'finishedAt', now)
  end
  table.insert(expired, uid)
  table.insert(expired, jti or '')
end

local admitted = {}
local abandoned = 0
if redis.call('EXISTS', KEYS[3]) == 1 then return {expired, admitted, abandoned} end

local free = tonumber(ARGV[2]) - redis.call('ZCARD', KEYS[2])
local n = math.min(free, tonumber(ARGV[3]), #ARGV - 6)
local cutoff = tonumber(ARGV[5])
local windowMs = tonumber(ARGV[4])
local used = 0
local guard = 0
while used < n and guard < n * 20 + 100 do
  guard = guard + 1
  local popped = redis.call('ZPOPMIN', KEYS[1], 1)
  if #popped == 0 then break end
  local uid = popped[1]
  local turn = prefix .. 'turn:' .. uid
  local lastSeen = tonumber(redis.call('HGET', turn, 'lastSeen') or '0')
  if lastSeen < cutoff then
    redis.call('HSET', turn, 'state', 'ABANDONED', 'finishedAt', now)
    abandoned = abandoned + 1
  else
    used = used + 1
    local jti = ARGV[6 + used]
    local expiresAt = now + windowMs
    redis.call('ZADD', KEYS[2], expiresAt, uid)
    redis.call('SET', prefix .. 'jti:' .. jti, uid, 'PX', windowMs)
    redis.call('HSET', turn, 'state', 'ADMITTED', 'jti', jti, 'admittedAt', now, 'expiresAt', expiresAt)
    table.insert(admitted, uid)
    table.insert(admitted, jti)
    table.insert(admitted, tostring(expiresAt))
  end
end
return {expired, admitted, abandoned}
`;

/**
 * Apertura de la venta: la prefila (ya barajada en Node con crypto) pasa a la fila con puntajes
 * negativos, delante de quienes lleguen después. Idempotente gracias a la marca `opened`.
 *
 * KEYS: opened, prequeue, waiting
 * ARGV: now, prefix, uid_1 … uid_n (orden aleatorio)
 * → cantidad movida (o -1 si ya estaba abierta)
 */
export const OPEN = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX') == false then return -1 end
local total = #ARGV - 2
local moved = 0
for i = 3, #ARGV do
  local uid = ARGV[i]
  if redis.call('SREM', KEYS[2], uid) == 1 then
    redis.call('ZADD', KEYS[3], (i - 3) - total, uid)
    redis.call('HSET', ARGV[2] .. 'turn:' .. uid, 'state', 'WAITING')
    moved = moved + 1
  end
end
-- Quien entró a la prefila mientras se barajaba queda al final de ese grupo.
for _, uid in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  redis.call('SREM', KEYS[2], uid)
  redis.call('ZADD', KEYS[3], 0, uid)
  redis.call('HSET', ARGV[2] .. 'turn:' .. uid, 'state', 'WAITING')
  moved = moved + 1
end
return moved
`;

/** KEYS: waiting, prequeue, active, events · ARGV: eventId. Atómico frente a un `join` concurrente. */
export const RETIRE = `
if redis.call('ZCARD', KEYS[1]) + redis.call('SCARD', KEYS[2]) + redis.call('ZCARD', KEYS[3]) == 0 then
  return redis.call('SREM', KEYS[4], ARGV[1])
end
return 0
`;
