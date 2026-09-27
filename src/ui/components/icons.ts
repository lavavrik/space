/*
 * Phosphor icons (MIT) for the ship's hardware: one per kind of avionics computer and module.
 * The panels pick them by the ids in hud/types.ts.
 */
import { Anchor, BatteryFull, CompassRose, Fan, Funnel, Planet, Scan, Snowflake, SquareHalf, Wrench, type Icon } from '@phosphor-icons/react';
import type { ComputerKind } from '../../game/avionics/catalog';
import type { ModuleIcon } from '../../game/hud/types';

export const AVIONICS_ICONS: Record<ComputerKind | 'outfit', Icon> = { orbit: Planet, scanner: Scan, nav: CompassRose, dock: Anchor, outfit: Wrench };
export const MODULE_ICONS: Record<ModuleIcon, Icon> = { battery: BatteryFull, scoop: Funnel, radiator: Snowflake, heatpump: Fan, empty: SquareHalf };
