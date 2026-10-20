// Everything Game builds for Funfair International, the A320neo and Palm Cay, behind one dynamic
// import: Game starts loading it with the fair (build()'s first step) and awaits it at the
// airport's first loading step, so this code (about half the game's script) downloads while the
// fair is being built instead of holding up the whole Game chunk, and the loading bar keeps moving.
// Only the classes and the data Game needs at build time are here; the small plan and geography
// modules the park's own code reads (aviation/airports, airport/terminal-plan, geo) stay in Game's
// chunk. Game imports this module's types with `import type` only, so nothing here is pulled into
// the Game chunk by a static import.

export { Traffic } from '../../aviation/traffic';
export { Airfield } from '../airport/airfield';
export { Airside, reservedStands } from '../airport/airside';
export { HomeTerminal } from '../airport/terminal';
export { DEFAULT_ARRIVALS, DEFAULT_DEPARTURES, scheduleBoards } from '../airport/boards';
export { Landside } from '../airport/landside';
export { SkyLink } from '../airport/skylink';
export { createA320, LIVERIES, warmA320 } from '../airport/a320-model';
export { PalmCay, PALM_CAY_WALK } from '../island/island';
export { ISLAND_ARRIVALS, ISLAND_DEPARTURES, IslandTerminal } from '../island/island-terminal';
export { JetSki } from '../attractions/island/jetski';
export { JETSKI_WALK } from '../attractions/island/jetski-dock';
export { Slides } from '../attractions/island/slides';
export { Cannons } from '../attractions/island/cannons';
export { Volley } from '../attractions/island/volley';
export { Travellers } from '../crowd/travellers';
export { Flight } from '../attractions/flight';
export { flightGround } from './ground';
