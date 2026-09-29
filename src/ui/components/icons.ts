/*
 * Phosphor icons (MIT) for the ship's hardware: one per kind of avionics computer and module.
 * The panels pick them by the ids in hud/types.ts.
 */
import { Anchor, Atom, Flask, Heartbeat, BatteryFull, Coins, CompassRose, Drop, Fan, Funnel, Crosshair, Lightning, Magnet, Package, Planet, PlugsConnected, RocketLaunch, Scan, Snowflake, SquareHalf, Wrench, type Icon } from '@phosphor-icons/react';
import type { ComputerKind } from '../../game/avionics/catalog';
import type { ModuleIcon } from '../../game/hud/types';

export const AVIONICS_ICONS: Record<ComputerKind | 'outfit', Icon> = { orbit: Planet, scanner: Scan, nav: CompassRose, dock: Anchor, outfit: Wrench };
export const MODULE_ICONS: Record<ModuleIcon, Icon> = { battery: BatteryFull, scoop: Funnel, radiator: Snowflake, heatpump: Fan, deflector: Magnet, guard: Crosshair, laser: Lightning, fuelcell: Flask, empty: SquareHalf };

/**
 * What the ship carries and pays with: hydrogen (a drop: it's stored liquid), oxygen (a heartbeat:
 * it's what life support breathes), exotic matter (an atom), credits (coins), the hold (a crate);
 * and the station's services (repairs, shore power, leaving).
 */
export const RESOURCE_ICONS = { prop: Drop, exotic: Atom, o2: Heartbeat, credits: Coins, cargo: Package, repair: Wrench, power: PlugsConnected, launch: RocketLaunch } satisfies Record<string, Icon>;
export type ResourceIcon = keyof typeof RESOURCE_ICONS;
