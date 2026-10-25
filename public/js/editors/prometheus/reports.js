// Prometheus: the science reports. One for every reading there is to take: REPORTS[body][where][kind], where is 'orbit'
// or a biome's id and kind is a SCIENCE key. A temperature report has the reading itself put in front of it, so the text
// here never gives the number.

export const REPORTS = {
  pandora: {
    orbit: {
      solar: 'From this close in, Prometheus A fills six degrees of sky and pours out some ninety-eight times the light Terra gets. The radiators held, though the hull facing the star ran hot enough to soften solder. Ultraviolet levels are punishing; the planet\'s own magnetic field is strong and keeps the worst of the flares off its air.',
      atmos: 'A thick, nitrogen-rich atmosphere with a healthy share of oxygen and a lot of water vapour. The day side boils it upward in one great column over the magma; it spreads out high up and sinks again over the night side, carrying heat round with it. Heavy molecules move far too slowly to escape a world this size: the air has been here for billions of years and will stay.',
      crew: 'The day side is one glowing wound, orange veined with yellow, too bright to look at without the filters. Around it a ring of tan desert, and past that, nothing: the night side just swallows the light. Then the instruments adjusted and we saw it, faint green flickers across the dark hemisphere. The whole crew went quiet. Something down there is glowing.',
    },
    dark: {
      surface: 'Soil saturated with organics: a deep black loam riddled with fungal threads and root-like mats. The rock underneath is pumice-light, full of holes, soaking up the water that rains out of the warm air coming over from the day side. The DNA-like molecules in the samples share their basic chemistry with life on Terra and Gaia. Whatever seeded those worlds passed through here too.',
      temp: 'Mild and steady, with almost no change from one hour to the next. There is no day here and no night, only the heat carried over by the wind from the far side of the world, and the warmth of the living mats underfoot as they break down what falls on them.',
      atmos: 'Breathable, or very nearly: oxygen a little under Terra\'s share, carbon dioxide a little higher, humidity close to saturation. Spores and pollen by the billion per cubic metre. Flight surgeons recommend filters, not tanks. The air smells, the sensors suggest, of rain and mushrooms.',
      crew: 'It isn\'t dark at all once your eyes adjust. Everything glows: soft green and teal from the mats on the ground, brighter flecks drifting in the air, slow pulses rippling across what we\'re calling trees for lack of a better word. Warm rain most of the time. Nobody wanted to go back inside. Commander logged the first spoken report from another living world in a whisper.',
    },
    desert: {
      surface: 'Sand blasted and baked into glass at the grain edges, rich in iron oxides and salts. The wind never stops here: it blows from the cold side toward the hot side along the ground and has scoured the bedrock into long grooves pointing at the sun. Thin crusts of dried microbial film in the shadows show life has tried to move in and keeps getting burned back.',
      temp: 'Hot, but survivable in a suit with good cooling. The star sits right on the horizon here and never moves: a half-disc of white fire, every shadow kilometres long and pointing the same way forever.',
      atmos: 'The same air as the dark side but bone-dry, every drop of water baked out of it. Dust storms carry fine, sharp grains high into it. Oxygen is fine to breathe; the dust is not.',
      crew: 'The star is a blinding half-circle on the horizon that never sets, and the whole desert glows orange around us. Behind us, toward the magma, the sky is a wall of shimmering heat and smoke. Ahead, toward the dark side, there is a faint green line at the edge of the world. Hottest, strangest sunset any of us has seen, and it\'s been going on for a billion years.',
    },
    sea: {
      water: 'Warm, faintly salty water, rich in dissolved minerals washed out of the porous crust. It teems: microbes, drifting colonies, things with fins and things that are more like lit-up nets. The sea glows wherever it is stirred up. Chemistry and genetic code are the same family as Terra\'s. If Terra had stayed this warm and this dark, its oceans might look like this.',
      temp: 'Cool but far from cold: the warm wind off the desert stirs the surface and the porous seabed lets heat seep up from below.',
      atmos: 'Humid, oxygen-rich, breathable with a filter. Salt spray and a sweet chemical smell the analyser can\'t quite place; it\'s coming from the glowing mats floating on the swell.',
      crew: 'Bobbing on a black sea under a black sky, except neither is black. Every wave breaks in blue-green light, and something big passes under us now and then trailing a glow like a comet. The radio crackles with static off the day side. We could sit here forever. Someone suggested we do.',
    },
  },
  terra: {
    orbit: {
      solar: 'The baseline every other reading is measured against: Prometheus A at 4.47 AU, giving exactly the light our panels are rated for. Flare activity is moderate and Terra\'s magnetic field shields the low orbits well. It\'s comforting to know what normal looks like.',
      atmos: 'Nitrogen, oxygen, a trace of argon and carbon dioxide, a thin film of water vapour and cloud. Beautifully unremarkable. The instruments are calibrated, and the program now has a point of comparison for every other sky in the system.',
      crew: 'Blue and white and green, and so small. The curve of the horizon, the thin glowing line of the atmosphere, the lights of the cities on the night side: all of it fits in one window. Everybody who has ever lived is down there except us. First crew report from orbit, filed with a slightly shaky voice.',
    },
  },
  dynamis: {
    orbit: {
      solar: 'The same light as Terra, give or take, with nothing to soften it. Dynamis has no field of its own; the radiation sensors read slightly higher here than in Terra orbit, from particles funnelled along Terra\'s magnetic tail.',
      crew: 'A little yellow moon, like a lemon someone dropped in space. Wide pale flats, a dark crater floor, and patches that steam faintly at the terminator. Close enough to Terra to see it hanging behind. Everyone wants to land on it.',
    },
    flats: {
      surface: 'Almost pure elemental sulfur, laid down in thin crusts by ancient vents, then cracked into polygons by the cold. Underneath, rock rich in sulfides and iron. A fine first sample: the program\'s first geology off-world smells of matches.',
      temp: 'Cold, but not as cold as it could be: the bright sulfur reflects much of the light and holds onto the little it absorbs.',
      crew: 'We\'re standing on yellow. Bright, crunching, everywhere. It cracks into little plates like dried mud when you step on it. Terra hangs huge and blue overhead, and for once you can see the whole thing at once. Low gravity: every step is a bound.',
    },
    crater: {
      surface: 'Darker material on the crater floor: the impactor\'s remains, an iron-nickel rock, mixed with melted and refrozen sulfur. Some of the sulfur here has turned red and brittle from the cold.',
      temp: 'Much colder than the flats around it: the crater walls shade the floor for most of the day, and the cold sinks and stays.',
      crew: 'The crater walls go up all around us like a stadium. It\'s darker here, colder, red-brown underfoot. The sky is a disc framed by the rim. Very quiet. Someone left a footprint they say they\'ll come back for.',
    },
    vents: {
      surface: 'Fresh sulfur deposits around warm vents, some still liquid in the deepest cracks. Traces of sulfuric acid and hydrogen sulfide. Heat from below says Dynamis is still not quite dead inside: Terra\'s pull flexes it a little each orbit.',
      temp: 'Warm, by any standard, and astonishing for a moon this small: the vents are fed by tidal heating from deep below.',
      crew: 'Little chimneys of yellow crust breathing out wisps of vapour that freeze and fall back as glittering dust. The ground is warm through the boots. If there\'s anywhere on this moon that might once have had something living in it, it\'s here. No sign yet.',
    },
  },
  sera: {
    orbit: {
      solar: 'Terra-like light, but Sera\'s thin nitrogen air does little to stop ultraviolet. The ocean surface reflects a lot of it back. Over the poles, faint aurora where particles hit the air.',
      atmos: 'Nitrogen, almost nothing else: no oxygen at all, a trace of water vapour, a trace of argon. Thin, at a third of an atmosphere, but enough to keep the ocean liquid. Dead air, chemically speaking: nothing is breathing it in or out.',
      crew: 'A dark blue marble with white caps at the poles. No land at all between them, no clouds to speak of, nothing moving. It\'s beautiful, but something about it is sad, like an empty house.',
    },
    ocean: {
      water: 'Fresh water, almost: very little salt, and almost nothing else dissolved. Sterile. Not a microbe, not an organic molecule above background. A perfectly good ocean that nothing ever lived in. Why life took on Terra and Gaia and not here is going to keep biologists busy for a long time.',
      temp: 'Just above freezing at the surface and colder below. Sera holds its warmth thanks to the ocean itself, which is slow to give heat away.',
      atmos: 'At sea level, pure nitrogen with water vapour off the waves. Unbreathable, but not poisonous. Air pressure about a third of Terra\'s: a suit and mask, not a full pressure suit.',
      crew: 'Grey-blue swells under a grey-blue sky. The waves are slow and tall in this gravity, and they lift us like a lift. No birds, no fish, no seaweed, no smell. Just the slap of water on the hull. We\'re the only living things on this whole world.',
    },
    north: {
      surface: 'Water ice, a few kilometres thick, with layers of dust and frozen nitrogen frost going back an unknown length of time. A core sample here is a record of Sera\'s climate. Nothing organic in any of it.',
      temp: 'Well below freezing: the cap is high and dry and reflects most of the light it gets.',
      atmos: 'Thin, cold nitrogen, even drier than over the ocean. Ice crystals blow across the cap in fine sheets.',
      crew: 'White in every direction, and the horizon is close. The sun stays low here, and the shadows are long and blue. The edge of the cap breaks off into the ocean in cliffs taller than any building on Terra.',
    },
    south: {
      surface: 'The same ice as the north cap, with a difference: dark bands of dust deposited by some old event, an impact maybe, layered deep in the ice. A good marker for working out how old the caps are.',
      temp: 'As cold as the north cap: the two are mirrors of each other.',
      atmos: 'Thin, cold nitrogen. The wind blows off the cap toward the ocean, and on a clear day you can see fog where it meets the warmer water.',
      crew: 'Like the north cap, but the ice here has dark stripes in it, like tree rings. The sky is clear and dark. We can see Terra on the horizon and, past it, the brighter stars of the system.',
    },
  },
  cobalt: {
    orbit: {
      solar: 'Terra\'s light without the air. Nothing unusual in the sunlight itself, but the reflected light off Cobalt is unusually blue: the metallic minerals scatter shorter wavelengths.',
      crew: 'Steel-blue and grey, like a cannonball. The scarps catch the light in long bright lines. The surveyors on board keep saying "look at all that ore" like it\'s a beautiful view. It sort of is.',
    },
    ore: {
      surface: 'Extraordinary. Iron, nickel, cobalt, platinum-group metals at concentrations ten times the richest mines on Terra. Probably the core of a much bigger body, smashed and stripped long ago. Every tonne of regolith dug here is worth more than a tonne sent up from home.',
      temp: 'Cold: a small, bare moon with no air to keep any heat in.',
      crew: 'The ground glints. Little flakes of metal in everything, and when the sun comes over the horizon the whole field flashes like frost. The geologist wouldn\'t stop picking things up. We\'ve brought back more samples than we were meant to.',
    },
    basin: {
      surface: 'A melt sheet from the impact that dug the basin: glassy, dark, rich in metals that sank and pooled while it was liquid. Good iron, harder to dig than the ore fields.',
      temp: 'Colder than the plains: the basin floor is low and dark and gives its heat up quickly.',
      crew: 'The basin floor is smooth and glossy, almost like a frozen lake of black glass. You can see your reflection in places. The rim is a jagged line on the far horizon.',
    },
    scarps: {
      surface: 'Fresh rock exposed along cliffs where the crust shrank and cracked as the moon cooled. Layers of different metals stacked like a cut cake: a record of how Cobalt\'s parent body separated into core and mantle.',
      temp: 'Close to the moon\'s average: the cliffs face every direction and share the light out evenly.',
      crew: 'Cliffs hundreds of metres tall, with stripes of blue and silver and rust-red. Landing was tricky but the view is worth it. We could see our own shadow on the scarp face.',
    },
  },
  cinder: {
    orbit: {
      solar: 'Prometheus A is noticeably smaller and dimmer here, about two-fifths of Terra\'s light. Cinder\'s weak magnetic field leaves the upper air exposed to the stellar wind, which slowly strips it.',
      atmos: 'Carbon dioxide and nitrogen with fine ash suspended in it, half an atmosphere thick. Not breathable, not very poisonous either. The ash makes for spectacular dark-red sunsets.',
      crew: 'A dark, dusty grey ball. A long scar runs down one side, the rift valley, and the highlands are a lighter, colder grey. Ash hazes everything at the limb. Grim, but impressive.',
    },
    ash: {
      surface: 'Fine volcanic ash, metres deep, with grains of glass and crystal. The volcanoes that made it went quiet a long time ago; the ash has since been sorted by wind into rippled sheets.',
      temp: 'Cold. The air is too thin and too dry to hold heat, and the dark ash loses it as fast as it gains it.',
      atmos: 'Carbon dioxide and nitrogen at half an atmosphere, with ash lifted by every gust. Filters clog within the hour.',
      crew: 'Grey dust to the horizon. Every step raises a puff that hangs in the air, and the wind picks it up and carries it off in snakes along the ground. The sun is small and orange through the haze.',
    },
    rift: {
      surface: 'Fresh basalt and older layers exposed down the valley walls. Signs of ancient lava flows and, near the floor, minerals that only form in water. Long ago there may have been a river down here.',
      temp: 'Warmer than the plains: the valley floor is deep, the air is thicker, and a little heat still seeps from the crust.',
      atmos: 'Thicker at the bottom of the rift, with traces of sulfur gases from deep cracks. Slightly warmer and noticeably more humid.',
      crew: 'Walls on both sides going up and up into haze. The floor is cracked and stepped, with old dark lava rivers frozen in place. It feels like walking down a gigantic corridor.',
    },
    basalt: {
      surface: 'Dense black basalt, worn into broad, flat tablelands. Barely any ash up here: the wind keeps it swept clean. Rich in iron and magnesium.',
      temp: 'Coldest place on Cinder: high, thin air and bare dark rock that radiates heat straight out to space.',
      atmos: 'Thin and dry. The pressure is noticeably lower up here, and the wind is fierce and constant.',
      crew: 'Black rock, flat as a table, with columns at the edges where the lava cracked as it cooled. The wind never stops. We had to anchor the lander. The ash clouds are below us.',
    },
  },
  palgal: {
    orbit: {
      solar: 'The same light as at Cinder. Pal and Gal pass in front of each other every few hours, so the panels see regular dips in power as one moon shades the other\'s side of the orbit.',
      crew: 'Two little lumps going round and round each other, so close you could almost toss a ball between them. One rusty, one pale. Hypnotic. We timed a whole swing: about a day.',
    },
  },
  pal: {
    rubble: {
      surface: 'Not solid rock at all: a heap of boulders, gravel and dust held together by its own weak gravity. Rusty from iron oxides, much like the dust on Cinder. Pal may be a chunk blasted off Cinder long ago.',
      temp: 'Cold, and steady: a rubble pile is a good insulator, so the heat of day barely reaches below the top few centimetres.',
      crew: 'Boulders the size of houses just sitting on top of each other. Nothing holds them down. Step too hard and you might launch yourself off the moon, so we\'re moving very carefully.',
    },
    saddle: {
      surface: 'Fine dust pooled in the low middle of the moon, where the pull from both ends meets. Smooth, rusty, and settled: the best place on Pal to land.',
      temp: 'Slightly warmer than the rest of Pal: the dust here soaks up the light and holds it.',
      crew: 'Smooth, dusty, rust-coloured valley. Gal hangs overhead, close enough that you can make out its pits with your bare eyes. It moves across the sky fast enough to watch.',
    },
    facing: {
      surface: 'Steep faces of solid rock where Gal\'s pull has, over millions of years, tugged loose rubble away. Layers of iron and darker mineral bands exposed.',
      temp: 'Coldest place on Pal: the cliffs face Gal and spend long stretches in its shadow.',
      crew: 'Cliffs facing straight at Gal. Gal fills a good part of the sky right in front of us. We could feel the lander shift a little as it swung round. Unsettling.',
    },
  },
  gal: {
    dust: {
      surface: 'Very fine, pale dust, almost a powder: grains of feldspar and frost-shattered rock. Electrically charged by sunlight, it floats a little above the surface at the terminator.',
      temp: 'Cold: the pale dust throws most of the light straight back.',
      crew: 'We\'re standing in flour. The dust is so fine it creeps up the boot and clings. At dusk it lifts off the ground in a low glowing mist. Pal looms red overhead.',
    },
    pits: {
      surface: 'Chains of collapse pits, where the surface has fallen into hollows below. Under the rim, fresh rock and traces of ice that never sees light. Gal may be hollow in places.',
      temp: 'Coldest anywhere around Cinder: the pit floors never see sunlight at all.',
      crew: 'A line of holes in the ground, like footprints of a giant. We looked over the edge of one and couldn\'t see the bottom with our lights. Nobody volunteered to climb down.',
    },
    ridge: {
      surface: 'A long ridge of pale, fractured rock on the side that always faces Pal. The two moons pull on each other hardest here, and the strain has cracked the crust into slabs and shaken the loose dust off them. Bare bedrock, the only place on Gal not buried in powder.',
      temp: 'The warmest place on Gal, if only just: the bare rock soaks up more light than the pale dust around it, and Pal\'s shadow rarely falls here.',
      crew: 'Pal fills the sky right in front of us, rusty and huge, swinging round fast enough to watch it move. The ridge under us is cracked into slabs like a broken pavement. Every so often the lander creaks as the two moons tug at each other.',
    },
  },
  baja: {
    orbit: {
      solar: 'Prometheus A is a small, bright disc here, about a twelfth of Terra\'s light. Baja\'s strong magnetic field traps a belt of charged particles around it: radiation readings in middle orbits are high.',
      atmos: 'Nitrogen and oxygen in almost Terran proportions, at half an atmosphere and bitterly cold. Breathable with heating and pressure assistance. Where the oxygen comes from is a mystery: nothing obvious is making it.',
      crew: 'Heavy, tan and orange, streaked with white salt and long shadows of canyons. A big family of moons all round it. Leaving is going to be expensive: you can feel the weight of the planet just looking at it.',
    },
    salt: {
      surface: 'Thick crusts of chlorides and sulfates where a sea dried away long ago. Microscopic fossils in the deepest layers: something lived in that sea, and died with it.',
      temp: 'Brutally cold: the bright salt reflects nearly all the light that reaches this far out.',
      atmos: 'Thin, very cold air, breathable but painful in the lungs without heating. Dry enough to pull moisture straight out of skin.',
      crew: 'White salt, flat to the horizon, cracked into hexagons. The sun is small and the sky is dark blue even at noon. Everything feels so heavy here: one-point-six g, and we\'re feeling every bit of it.',
    },
    dunes: {
      surface: 'Grains of frozen sand and water ice blown into dunes hundreds of metres tall. The sand is iron-rich and orange; the ice glues it together near the surface.',
      temp: 'Cold, but a few degrees warmer than the pan: the darker sand soaks up a little more light.',
      atmos: 'Thin, cold, breathable. The wind is steady and moves the dunes a few metres a year.',
      crew: 'Orange dunes in waves, bigger than any desert on Terra. The tops smoke where the wind takes the sand. Walking is exhausting: every step sinks, and every step weighs more than at home.',
    },
    canyons: {
      surface: 'Layered rock walls a kilometre deep, carved by water that ran here before Baja froze. Fossil river beds, ripple marks, and clays. A whole history of a warmer Baja written in the walls.',
      temp: 'Cold. The canyon floors are sheltered from the wind, but the light rarely reaches them.',
      atmos: 'Thicker and a little warmer at the bottom of the canyons. The air pools here. Breathable with a light mask.',
      crew: 'Like the oldest landscapes on Terra, but bigger, redder and frozen. The walls go up in stripes. There were rivers here, it\'s obvious just to look. We wonder where they went.',
    },
  },
  eros: {
    orbit: {
      solar: 'The light is the same as at Baja. Eros spends part of each short orbit in Baja\'s shadow, and its surface temperature swings hard between the two.',
      crew: 'A long, rosy pebble, pinched in the middle, skimming so close above Baja that the planet fills half the sky. One end has a big heart-shaped basin. The crew have nicknamed it "the Valentine".',
    },
    rose: {
      surface: 'Fine pink regolith, coloured by traces of manganese and iron. The dust here slowly sheds off into space each time Eros passes close to Baja.',
      temp: 'Freezing cold, but changeable: Eros passes in and out of Baja\'s shadow every few hours.',
      crew: 'Soft pink dust under a black sky, with Baja huge and orange overhead. It looks like a postcard. Low gravity, so low that walking is basically floating.',
    },
    heart: {
      surface: 'A wide basin floored with bright, smooth material, an impact that melted and spread out. The shape is coincidence, but the samples are a pristine record of when Eros was struck.',
      temp: 'Cold: the pale basin reflects much of the light it gets.',
      crew: 'We landed in the heart. It\'s smooth and pale, edged with darker rose. Everyone took photos. The flight director requested we keep comments professional. We did not.',
    },
    waist: {
      surface: 'The narrowest part of the moon, with fresh cracks where Baja\'s tides are slowly stretching it. In a few million years Eros may break here and fall onto its planet.',
      temp: 'The coldest part of Eros: the narrow waist has the least rock to hold heat.',
      crew: 'Cracks everywhere. Not big, but fresh-looking, and we felt a small tremor right after landing. Baja is tugging on this moon, and you can feel it. Short stay, by unanimous vote.',
    },
  },
  gaia: {
    orbit: {
      solar: 'Baja\'s light, a twelfth of Terra\'s, but Gaia\'s thick air traps it well. Baja\'s radiation belts reach out here, and Gaia\'s own magnetic field, stirred by its tidally heated core, holds them off.',
      atmos: 'Nitrogen and oxygen at 1.2 atmospheres, warm, and full of water vapour, methane and complex organic molecules. A living atmosphere: out of balance in exactly the way only biology keeps it.',
      crew: 'Green. Green and blue, wrapped in clouds, with Baja rising behind it orange and huge. It\'s so like Terra that the crew went quiet. Then someone said "we\'re not the only ones", and nobody disagreed.',
    },
    seas: {
      water: 'Warm, shallow and salty, full of microbial mats and small free-swimming creatures. The biochemistry is unmistakably related to Terra\'s: the same handedness of molecules, the same basic genetic code. Terra and Gaia share an ancestor, and it came from somewhere else.',
      temp: 'Mild, and steadier than any sea on Terra: tidal heat from below keeps it warm whatever the season.',
      atmos: 'Warm, humid and breathable. A rich, salty smell. Air sampling picks up spores and microscopic organisms, harmless as far as anyone can tell.',
      crew: 'Clear green water, warm to the touch, with things swimming in it. Little things, and some not so little. Baja hangs in the sky like a second sun, orange and enormous. This is the best day of all our lives.',
    },
    forest: {
      surface: 'A deep, spongy carpet of moss-like growth over rich soil, thick with roots and fungal threads. Plants here use a pigment close to Terra\'s chlorophyll but tuned to Prometheus A\'s whiter light: a deeper, bluer green.',
      temp: 'Mild under the canopy, cooler than the seas, and very humid.',
      atmos: 'Breathable, oxygen-rich, thick with spores and scent. Higher oxygen than Terra: fires would burn fast here.',
      crew: 'The moss is taller than we are. Stalks of it, swaying, and the light under them is deep green and blue. It\'s silent except for clicks and hums from things we haven\'t seen yet. We\'re not alone in here.',
    },
    uplands: {
      surface: 'Thin soils over volcanic rock, colonised by low ground cover and crusts. Fewer species than the forests but tougher ones: a picture of what Gaia was like before its forests spread.',
      temp: 'Cooler, especially at night: the uplands are high and the air thinner.',
      atmos: 'A little thinner than at sea level but still richly breathable. Clear, cool and windy.',
      crew: 'Rolling green hills, wind in the grass that isn\'t quite grass. We can see the seas and the forests below. If you didn\'t look up at Baja, you might think you were home.',
    },
  },
  tartarus: {
    orbit: {
      solar: 'Baja\'s light again, but Tartarus has no magnetic field and sits deep in Baja\'s radiation belt. The dosimeters climbed steadily the whole time we were here.',
      atmos: 'Sulfur dioxide, very thin, continuously puffed out by vents and stripped away by Baja\'s magnetic field. A torus of sulfur and oxygen ions trails the moon round its orbit.',
      crew: 'Black and red, scarred by a chasm that glows at the bottom. Smoke rises out of cracks all over it. It looks like something out of a nightmare. The flight surgeon checked our radiation badges twice.',
    },
    brimstone: {
      surface: 'Fields of yellow and red sulfur, freshly laid down by vents. Underneath, darker silicate rock. The whole surface is being repaved every few thousand years.',
      temp: 'Freezing on the surface, hot underneath: the vents keep the sulfur moving but the thin air holds no heat.',
      atmos: 'Thin sulfur dioxide, and poisonous. Corrosive to seals. Full pressure suits, short stays.',
      crew: 'Yellow, orange, black and red. Vents hiss all around us and frost forms on everything they breathe out. It\'s ugly and beautiful at the same time. It also smells terrible through the suit filters.',
    },
    cliffs: {
      surface: 'Cliffs of iron-rich rock rusted in streaks, with veins of pyrite and magnetite. Some of the richest iron anywhere in the system, if anyone wants to mine a moon this unpleasant.',
      temp: 'Very cold: the cliffs stand high, away from the vents, in thin dry air.',
      atmos: 'Thin sulfur dioxide, carried up from the plains by the wind. Slightly less of it up here.',
      crew: 'Rust-red walls with veins that shine like gold. Fool\'s gold, the geologist says. Still, it\'s gorgeous. The chasm glow lights up the sky to one side.',
    },
    abyss: {
      surface: 'The chasm floor: rock still hot from the inside, with liquid sulfur seeping between cracks. Tartarus is being stretched open here by Baja\'s tides. Molten silicate is less than a kilometre down.',
      temp: 'Hot, hot enough to boil water if there were any: the floor is close to magma.',
      atmos: 'Thicker than anywhere else on Tartarus and fiercely poisonous: sulfur dioxide, hydrogen sulfide and sulfur vapour, venting straight from the crust.',
      crew: 'We\'re at the bottom of the chasm. The walls rise kilometres on both sides, lit orange from below. The ground glows through the cracks. The lander\'s skin temperature is climbing. We\'re not staying long.',
    },
  },
  erebus: {
    orbit: {
      solar: 'Baja\'s light, but Erebus reflects almost none of it: its surface is one of the darkest in the system. On the ridges, plumes catch the light like candle flames.',
      crew: 'A dark grey ball with faint white lines and every so often a bright plume going up from the ridges, glittering, then falling back. Like a fountain in the dark.',
    },
    shadow: {
      surface: 'Water ice darkened by a coating of soot: tholins and carbon compounds made by radiation from organic molecules in the ice. The ice underneath is clean and very old.',
      temp: 'Deeply cold: even the dark ice can\'t gather enough light this far from the star to warm it.',
      crew: 'The ground is almost black and soft, crunchy ice under a dark coating. The sky is black. Baja is a dim orange crescent. Our lights are swallowed up within metres.',
    },
    cryo: {
      surface: 'Fresh ice around the vents, mixed with ammonia and salts. Something liquid is down there: a subsurface ocean, kept warm by Baja\'s tides. Organic compounds in the plume deposits.',
      temp: 'Still deep in the cold, but much warmer than the plains around: fresh material from below hasn\'t cooled yet.',
      crew: 'A plume went up while we were watching, silent, hundreds of metres high. Then it snowed on us. White snow at first, then grey, then black. Absolutely incredible.',
    },
    soot: {
      surface: 'Snow that fell from the plumes and was darkened by radiation on the way down. Layered deposits record every eruption for thousands of years.',
      temp: 'Extremely cold: the black snow takes in some light, but it\'s spread thin.',
      crew: 'Black snow, fluffy and fine, metres deep. Every step leaves a footprint that will be here for longer than our civilisation, probably. We wrote our names. Don\'t tell the flight director.',
    },
  },
  nyx: {
    orbit: {
      solar: 'The weakest light of any of Baja\'s moons, and the least radiation: Nyx orbits far outside Baja\'s belts. A good place to park a sensitive instrument.',
      crew: 'Very dark, almost invisible against the sky until the frost catches the light and it glitters like a scatter of stars on a black cloth. Hard to look away from.',
    },
    night: {
      surface: 'Dark carbon-rich rock, like the oldest meteorites on Terra. Nyx may be a captured body, older than Baja itself, carrying the system\'s first materials.',
      temp: 'Close to the coldest anywhere in the Prometheus system.',
      crew: 'Black. We can only see what the lights touch. The stars are brighter than anywhere we\'ve been. It feels like standing in deep space with a floor.',
    },
    frost: {
      surface: 'Frozen nitrogen and carbon monoxide crystals on the dark rock, growing into delicate blades. They catch the light and scatter it in sparkles.',
      temp: 'The coldest place anyone has landed: the frost reflects away the little light it gets.',
      crew: 'Our lights hit the frost and it lit up like a sky full of stars beneath us. Every move of the lamp changes the pattern. We\'ve never seen anything like it.',
    },
    dusk: {
      surface: 'A raised ridge where the dark rock is broken and exposed. Ancient impact debris, unaltered for billions of years. Some grains here are older than Prometheus A.',
      temp: 'Marginally warmer than the plains: the ridge catches the low light longer.',
      crew: 'Up on the ridge we can see the frost fields below, glittering, and the night plains beyond, totally black. Baja is a small orange dot. Beautiful and very, very lonely.',
    },
  },
  onyx: {
    orbit: {
      solar: 'Prometheus A is just a very bright star here, a fortieth of Terra\'s light. The orange haze absorbs most of the ultraviolet before it gets anywhere near the ground.',
      atmos: 'Carbon monoxide, methane, nitrogen and complex hydrocarbon haze, eight-tenths of an atmosphere. Poisonous and flammable if there were any oxygen to burn it with. There isn\'t.',
      crew: 'A dim orange ball of haze, almost featureless. Infrared shows the shapes underneath: dark plains, lakes, a long bright ridge. A world painted in soot.',
    },
    graphite: {
      surface: 'Graphite, carbides and frozen hydrocarbons where other worlds have silicate rock. The ground is slippery and soft. A whole planet made out of pencil lead.',
      temp: 'Deeply cold, colder than anything except the outer moons.',
      atmos: 'Thick, cold, poisonous: carbon monoxide and methane, with haze droplets drifting down like soot snow.',
      crew: 'The ground is grey-black and shiny. It smears when you touch it. The sky is orange and the light is like a permanent sunset. Everything leaves a black mark on the suits.',
    },
    lakes: {
      water: 'Not water: liquid ethane and methane, with dissolved nitrogen and dark organics. Some of the molecules are surprisingly complex. Nothing living as far as we can tell, but the chemistry is busy.',
      temp: 'Cold enough for natural gas to lie in lakes.',
      atmos: 'Thick and poisonous, saturated with methane and ethane vapour over the lakes. Low clouds of hydrocarbon drizzle.',
      crew: 'Floating on a lake of natural gas. The surface is glassy and dark and reflects the orange sky. It drizzles methane. If anything ever lit up in here, it would be quite a show. Nothing will.',
    },
    diamond: {
      surface: 'Seams of diamond running through the scarp face, squeezed out of the carbon crust when it buckled. Not gemstone quality, mostly: industrial grit, by the mountain.',
      temp: 'Cold. The scarps are high and catch the wind.',
      atmos: 'Thinner and windier up the scarps, but still poisonous.',
      crew: 'The scarp glitters. Whole cliffs veined with diamond, catching our lights. The geologist laughed for about a full minute. We\'re bringing samples home. Lots of them.',
    },
  },
  starb: {
    orbit: {
      solar: 'A dim red dwarf: a hundredth of the Sun\'s light, almost all of it red and infrared. Solar panels are useless this far out. But it flares, often and violently: in a few minutes it can brighten many times over, and the radiation spikes with it.',
      crew: 'A huge, dull red ball, with dark spots and slowly moving bright patches. Then a flare went off and the whole thing lit up white along one edge. We felt the radiation alarm before we saw it.',
    },
  },
  yalu: {
    orbit: {
      solar: 'Prometheus B\'s red light, very weak, and its flares, very strong. Yalu\'s thick hydrogen air and strong magnetic field protect the surface; orbit is less lucky.',
      atmos: 'Mostly hydrogen, with helium, water vapour and methane, at four atmospheres. The light gas holds in heat like a thick blanket, enough to keep seas liquid under a sun this dim.',
      crew: 'A deep violet world in red twilight. The terminator is a soft smear. Little glints of the sea under the haze. Strange and warm-looking. Climbing back out is going to hurt.',
    },
    sea: {
      water: 'Liquid water, warm, rich in dissolved hydrogen and ammonia. Purple pigments in the water from microbial life: simple, single-celled, and not related to anything on Terra or Gaia. A second origin of life.',
      temp: 'Pleasantly warm, kept so by the hydrogen blanket overhead.',
      atmos: 'Hydrogen and water vapour at four atmospheres. Not poisonous, but not breathable either. Your voice comes out high and squeaky through the open radio channel.',
      crew: 'Purple water, warm, gentle waves, a red sun hanging low and huge. The air is thick: sounds carry strangely. We think there\'s something alive in the water, but it\'s small. Life, completely separate from ours.',
    },
    shores: {
      surface: 'Fine black volcanic sand, with purple microbial films in the wet layers just below the surface. The black sand drinks in the dim red light and stays warm.',
      temp: 'Warm, the warmest of Yalu\'s lowlands: the black sand holds the heat.',
      atmos: 'Thick, warm hydrogen with sea spray. Humid. Unbreathable, and the hydrogen leaks through every seal you have.',
      crew: 'Black sand, purple waves, red sky. We sat on the shore for a while just watching. The waves are slow and heavy. It\'s the most alien beach and the most beautiful.',
    },
    steam: {
      surface: 'Volcanic rock, mineral crusts and hot springs. Geysers throw water high into the thick air. Mineral deposits in reds and purples where microbes grow in the warm runoff.',
      temp: 'Hot, near the springs; the ground steams constantly.',
      atmos: 'Thick hydrogen loaded with steam and sulfur gases from the springs. Hot and wet.',
      crew: 'Clouds of steam rising out of every crack. Geysers going off on all sides. The ground rumbles. It\'s hot and noisy and wonderful, and everything is purple and red.',
    },
  },
  vega: {
    orbit: {
      solar: 'Prometheus B\'s red light, dimmer still this far out. Vega\'s enormous magnetic field holds the strongest radiation belts in the system; parking orbits need to stay high to avoid frying the electronics.',
      atmos: 'Helium, carbon monoxide and soot, with almost no hydrogen at all. Something stripped this giant\'s hydrogen away long ago, probably Prometheus B in its violent youth. A gas giant that shouldn\'t exist.',
      crew: 'Bands of lilac and slate grey, with storms swirling between them the size of Terra. It doesn\'t end: the horizon just keeps going. Hard to feel anything other than very small.',
    },
  },
};

/** The report for a reading's key (kind:body or kind:body:where), or null. */
export function reportFor(key) {
  const [kind, body, where = 'orbit'] = key.split(':');
  return REPORTS[body]?.[where]?.[kind] || null;
}
