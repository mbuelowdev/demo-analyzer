// Parquet layout per match (spec "Storage layout"). Bump SCHEMA_VERSION when columns change
// so outdated matches can be found and re-parsed (R-PARSE-3).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const demoparserVersion: string = require('@laihoe/demoparser2/package.json').version;

export const SCHEMA_VERSION = 1;
/** Our extraction code version + the demoparser2 version that produced the data. */
export const PARSER_VERSION = `2+demoparser2@${demoparserVersion}`;

export type ColType = 'float' | 'int' | 'bool' | 'varchar' | 'ubigint' | 'list_varchar' | 'json';

export interface TickColumn {
  /** Output column name in ticks.parquet. */
  col: string;
  /** demoparser2 prop name (friendly or raw entity path). */
  prop: string;
  type: ColType;
  /** For vec props: which component to take. */
  index?: number;
}

const AIM_PUNCH = 'CCSPlayerPawn.CCSPlayer_AimPunchServices.m_predictableBaseAngle';
const AIM_PUNCH_UNPRED = 'CCSPlayerPawn.CCSPlayer_AimPunchServices.m_unpredictableBaseAngle';
const VIEW_PUNCH = 'CCSPlayerPawn.CCSPlayer_CameraServices.m_vecCsViewPunchAngle';
const SPOTTED_BY = 'CCSPlayerPawn.m_bSpottedByMask';

/**
 * Per-tick player state (R-PARSE-2). Field availability was measured in docs/SPIKE.md:
 * the friendly `aim_punch_angle` is empty in current demos, the AimPunchServices paths carry it;
 * `approximate_spotted_by` collides with the raw mask path, so only the raw path is requested.
 */
export const TICK_COLUMNS: TickColumn[] = [
  { col: 'x', prop: 'X', type: 'float' },
  { col: 'y', prop: 'Y', type: 'float' },
  { col: 'z', prop: 'Z', type: 'float' },
  { col: 'pitch', prop: 'pitch', type: 'float' },
  { col: 'yaw', prop: 'yaw', type: 'float' },
  { col: 'vel_x', prop: 'velocity_X', type: 'float' },
  { col: 'vel_y', prop: 'velocity_Y', type: 'float' },
  { col: 'vel_z', prop: 'velocity_Z', type: 'float' },
  { col: 'health', prop: 'health', type: 'int' },
  { col: 'armor', prop: 'armor_value', type: 'int' },
  { col: 'has_helmet', prop: 'has_helmet', type: 'bool' },
  { col: 'has_defuser', prop: 'has_defuser', type: 'bool' },
  { col: 'team_num', prop: 'team_num', type: 'int' },
  { col: 'is_alive', prop: 'is_alive', type: 'bool' },
  { col: 'total_rounds_played', prop: 'total_rounds_played', type: 'int' },
  { col: 'weapon', prop: 'active_weapon_name', type: 'varchar' },
  { col: 'ammo', prop: 'active_weapon_ammo', type: 'int' },
  { col: 'ammo_reserve', prop: 'total_ammo_left', type: 'int' },
  { col: 'shots_fired', prop: 'shots_fired', type: 'int' },
  { col: 'recoil_index', prop: 'fl_recoil_idx', type: 'float' },
  { col: 'accuracy_penalty', prop: 'accuracy_penalty', type: 'float' },
  { col: 'is_scoped', prop: 'is_scoped', type: 'bool' },
  { col: 'ducking', prop: 'ducking', type: 'bool' },
  { col: 'is_walking', prop: 'is_walking', type: 'bool' },
  { col: 'is_airborne', prop: 'is_airborne', type: 'bool' },
  { col: 'is_defusing', prop: 'is_defusing', type: 'bool' },
  { col: 'in_bomb_zone', prop: 'in_bomb_zone', type: 'bool' },
  { col: 'flash_duration', prop: 'flash_duration', type: 'float' },
  { col: 'flash_max_alpha', prop: 'flash_max_alpha', type: 'float' },
  { col: 'money', prop: 'balance', type: 'int' },
  { col: 'equip_value', prop: 'current_equip_value', type: 'int' },
  { col: 'cash_spent_round', prop: 'cash_spent_this_round', type: 'int' },
  { col: 'place', prop: 'last_place_name', type: 'varchar' },
  { col: 'spotted', prop: 'spotted', type: 'bool' },
  { col: 'spotted_by', prop: SPOTTED_BY, type: 'list_varchar' },
  { col: 'aim_punch_pitch', prop: AIM_PUNCH, type: 'float', index: 0 },
  { col: 'aim_punch_yaw', prop: AIM_PUNCH, type: 'float', index: 1 },
  { col: 'aim_punch_unpred_pitch', prop: AIM_PUNCH_UNPRED, type: 'float', index: 0 },
  { col: 'aim_punch_unpred_yaw', prop: AIM_PUNCH_UNPRED, type: 'float', index: 1 },
  { col: 'view_punch_pitch', prop: VIEW_PUNCH, type: 'float', index: 0 },
  { col: 'view_punch_yaw', prop: VIEW_PUNCH, type: 'float', index: 1 },
  { col: 'inventory', prop: 'inventory', type: 'list_varchar' },
  // usercmd data: parsed when present, never required by an indicator (spec assumption).
  { col: 'cmd_viewangle_x', prop: 'usercmd_viewangle_x', type: 'float' },
  { col: 'cmd_viewangle_y', prop: 'usercmd_viewangle_y', type: 'float' },
  { col: 'cmd_mouse_dx', prop: 'usercmd_mouse_dx', type: 'int' },
  { col: 'cmd_mouse_dy', prop: 'usercmd_mouse_dy', type: 'int' },
  { col: 'cmd_forward_move', prop: 'usercmd_forward_move', type: 'float' },
  { col: 'cmd_left_move', prop: 'usercmd_left_move', type: 'float' },
  { col: 'cmd_buttons', prop: 'usercmd_buttonstate_1', type: 'ubigint' },
  { col: 'cmd_buttons_changed', prop: 'usercmd_buttonstate_2', type: 'ubigint' },
  { col: 'cmd_buttons_scroll', prop: 'usercmd_buttonstate_3', type: 'ubigint' },
  { col: 'cmd_weapon_select', prop: 'usercmd_weapon_select', type: 'int' },
];

/** Sub-tick view-angle history per usercmd; flattened into usercmd_history.parquet (JSON in ticks was 2/3 of the size). */
export const INPUT_HISTORY_PROP = 'usercmd_input_history';
export const INPUT_HISTORY_FIELDS = ['player_tick_count', 'player_tick_fraction', 'render_tick_count', 'render_tick_fraction', 'x', 'y', 'z'] as const;

/** Extra player fields attached to every event's user/attacker/victim (R-PARSE-2). */
export const EVENT_PLAYER_EXTRA = [
  'X', 'Y', 'Z', 'pitch', 'yaw', 'team_num', 'active_weapon_name', 'is_scoped', 'health', 'flash_duration', 'is_airborne', 'ducking',
];
export const EVENT_OTHER_EXTRA = ['total_rounds_played', 'is_warmup_period', 'is_freeze_period'];

/** Per-round snapshot props sampled at round boundaries (no round_end event in MM GOTV demos, see SPIKE.md). */
export const ROUND_PROPS = [
  'team_num', 'team_rounds_total', 'round_win_status', 'round_win_reason', 'total_rounds_played', 'balance',
  'current_equip_value', 'round_start_equip_value', 'cash_spent_this_round', 'is_alive', 'kills_this_round',
  'damage_this_round', 'enemies_flashed_this_round', 'utility_damage_this_round', 'is_warmup_period',
  'is_match_started', 'game_phase', 'mvps', 'score', 'rank', 'comp_rank_type', 'comp_wins', 'crosshair_code',
];
