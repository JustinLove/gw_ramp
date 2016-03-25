requireGW([
    'shared/gw_common',
    'shared/gw_credits',
    'shared/gw_factions',
    'shared/Graph',
    'pages/gw_start/gw_breeder',
    'pages/gw_start/gw_dealer',
    'pages/gw_start/gw_teams',
    'main/shared/js/star_system_templates',
    'main/game/galactic_war/shared/js/gw_easy_star_systems'
], function(
    GW,
    GWCredits,
    GWFactions,
    Graph,
    GWBreeder,
    GWDealer,
    GWTeams,
    normal_system_templates, /* this actually won't load -- window.star_system_templates is set instead */
    easy_system_templates
) {
  var baseNeutralStars = 2;

  var estimatePlayers = function(system) {
    if (system.players) return system.players

    var lzPerPlayers = [0,0,0,0,0,0,0,0,0,0,0]
    system.planets.forEach(function(planet) {
      if (Array.isArray(planet.landing_zones)) {
        for (var p = 2;p <= 10;p++) {
          lzPerPlayers[p] = lzPerPlayers[p] + planet.landing_zones.length
        }
      } else if (planet.landing_zones) {
        var lz = planet.landing_zones
        var zones
        for (var p = 2;p <= 10;p++) {
          zones = 0
          for (var i = 0;i < lz.rules.length;i++) {
            if (lz.rules[i].min <= p && p <= lz.rules[i].max) {
              zones++
            }
          }
          lzPerPlayers[p] = lzPerPlayers[p] + zones
        }
      }
    })
    var players = lzPerPlayers
      .map(function(n, p) {return Math.min(n, p)})
      .filter(function(n) {return n != 0})
    var mm = [2,10]
    if (players.length > 0) {
      mm = [
        Math.min.apply(Math, players),
        Math.max.apply(Math, players),
      ]
    }
    //console.log(system.players, mm, lzPerPlayers)
    return mm
  }

  model.makeGame = function () {
    model.newGame(undefined);

    var busyToken = {};
    model.makeGameBusy(busyToken);

    var game = new GW.Game();

    game.name(model.newGameName());
    game.mode(model.mode());
    game.hardcore(model.newGameHardcore());
    game.content(api.content.activeContent());

    var useEasySystems = GW.balance.difficultyInfo[model.newGameDifficultyIndex() || 0].useEasierSystemTemplate;
    var systemTemplates = useEasySystems ? easy_system_templates : star_system_templates;
    var sizes = GW.balance.numberOfSystems;
    var size = sizes[model.newGameSizeIndex()] || 40;

    if (model.creditsMode()) {
      size = _.reduce(GWFactions, function(factionSum, faction) {
        return _.reduce(faction.teams, function(teamSum, team) {
          return teamSum + (team.workers || []).length;
        }, factionSum + 1);
      }, 0);
    }

    model.updateCommander();
    game.inventory().setTag('global', 'playerFaction', model.playerFactionIndex());
    game.inventory().setTag('global', 'playerColor', model.playerColor());

    var buildGalaxy = game.galaxy().build({
      seed: model.newGameSeed(),
      size: size,
      difficultyIndex: model.newGameDifficultyIndex() || 0,
      systemTemplates: systemTemplates,
      content: game.content(),
      minStarDistance: 2,
      maxStarDistance: 4,
      maxConnections: 4,
      minimumDistanceBonus: 8
    });
    var dealStartCard = buildGalaxy.then(function(galaxy) {
      if (model.makeGameBusy() !== busyToken)
        return;
      return GWDealer.dealCard({
        id: model.activeStartCard().id(),
        inventory: game.inventory(),
        galaxy: galaxy,
        star: galaxy.stars()[galaxy.origin()]
      }).then(function(startCardProduct) {
        game.inventory().cards.push(startCardProduct || { id: model.activeStartCard().id() });
      });
    });
    var moveIn = dealStartCard.then(function() {
      if (model.makeGameBusy() !== busyToken)
        return;
      game.move(game.galaxy().origin());

      var star = game.galaxy().stars()[game.currentStar()];
      star.explored(true);

      game.gameState(GW.Game.gameStates.active);
    });
    var populate = moveIn.then(function() {
      if (model.makeGameBusy() !== busyToken)
        return;

      // Scatter some AIs
      var aiFactions = _.range(GWFactions.length);
      aiFactions.splice(model.playerFactionIndex(), 1);
      if (!model.creditsMode())
        aiFactions = _.shuffle(aiFactions);
      var teams = _.map(aiFactions, GWTeams.getTeam);
      if (model.creditsMode()) {
        // Duplicate the workers so we can keep them unique
        _.forEach(teams, function(team) {
          team.workers = (team.workers || []).slice(0);
        });
      }

      var teamInfo = _.map(teams, function (team, teamIndex) {
        return {
          team: team,
          workers: [],
          faction: aiFactions[teamIndex]
        };
      });

      var neutralStars = baseNeutralStars;
      // Over-spread to take up all the neutral stars
      if (model.creditsMode())
        neutralStars = 0;

      return GWBreeder.populate({
        galaxy: game.galaxy(),
        teams: teams,
        neutralStars: neutralStars,
        orderedSpawn: model.creditsMode(),
        spawn: function (star, ai) {
        },
        canSpread: function (star, ai) {
          return !model.creditsMode() || !ai || !!teams[ai.team].workers.length;
        },
        spread: function (star, ai) {
          var team = teams[ai.team];
          return GWTeams.makeWorker(star, ai, team).then(function() {
            if (team.workers)
              _.remove(team.workers, function(worker) { return worker.name === ai.name; });

            ai.faction = teamInfo[ai.team].faction;
            teamInfo[ai.team].workers.push({
              ai: ai,
              star: star
            });
          });
        },
        boss: function (star, ai) {
          return GWTeams.makeBoss(star, ai, teams[ai.team], systemTemplates).then(function() {
            ai.faction = teamInfo[ai.team].faction;
            teamInfo[ai.team].boss = ai;
          });
        },
        breedToOrigin : game.isTutorial()
      }).then(function() {
        return teamInfo;
      });
    });

    var finishAis = populate.then(function(teamInfo) {
      if (model.makeGameBusy() !== busyToken)
        return;

      // DIFFICULTY RAMPING CODE
      //console.log(" START DIFFICULTY RAMPING ");
      var maxDist = _.reduce(game.galaxy().stars(), function (value, star) {
        return Math.max(star.distance(), value);
      }, 0);
      var diffInfo = GW.balance.difficultyInfo[game.galaxy().difficultyIndex];

      var setAIData = function(ai, dist, isBoss) {
        //console.log("AI DIFF START: " + ai + " dist: " + dist + " boss: " + isBoss);
        if (ai.personality === undefined)
          ai.personality = {};
        if (diffInfo.rampDifficulty) {
          ai.econ_rate = diffInfo.econBase + (dist * diffInfo.econRatePerDist);
          //console.log(ai.name + " setAI RATE: " + ai.econ_rate);
          //console.log(ai.name, dist, ai.econ_rate)

          var sizeMod = GW.balance.galaxySizeDiffMod[model.newGameSizeIndex() || 0];

          ai.personality.metal_drain_check = diffInfo.metalDrainCheck + (dist * diffInfo.metalDrainCheckPerDist * sizeMod);
          ai.personality.metal_demand_check = diffInfo.metalDemandCheck + (dist * diffInfo.metalDemandCheckPerDist * sizeMod);
          ai.personality.energy_drain_check = diffInfo.energyDrainCheck + (dist * diffInfo.energyDrainCheckPerDist * sizeMod);
          ai.personality.energy_demand_check = diffInfo.energyDemandCheck + (dist * diffInfo.energyDemandCheckPerDist * sizeMod);
        }
        else {
          ai.personality.metal_drain_check = diffInfo.metalDrainCheck;
          ai.personality.metal_demand_check = diffInfo.metalDemandCheck;
          ai.personality.energy_drain_check = diffInfo.energyDrainCheck;
          ai.personality.energy_demand_check = diffInfo.energyDemandCheck;
        }

        if (!isBoss) {
          ai.personality.percent_vehicle = diffInfo.percent_vehicle;
          ai.personality.percent_bot = diffInfo.percent_bot;
          ai.personality.percent_air = diffInfo.percent_air;
          ai.personality.percent_naval = diffInfo.percent_naval;
          ai.personality.neural_data_mod = diffInfo.neuralDataMod;
        }
        ai.personality.micro_type = diffInfo.microType;
        ai.personality.go_for_the_kill = diffInfo.goForKill;
        ai.personality.priority_scout_metal_spots = diffInfo.priority_scout_metal_spots;
        ai.personality.factory_build_delay_min = diffInfo.factory_build_delay_min;
        ai.personality.factory_build_delay_max = diffInfo.factory_build_delay_max;
        ai.personality.adv_eco_mod = diffInfo.adv_eco_mod;
        ai.personality.adv_eco_mod_alone = diffInfo.adv_eco_mod_alone;
        ai.personality.unable_to_expand_delay = diffInfo.unable_to_expand_delay;
        ai.personality.enable_commander_danger_responses = diffInfo.enable_commander_danger_responses;
        ai.personality.per_expansion_delay = diffInfo.per_expansion_delay;
        ai.personality.fabber_to_factory_ratio_basic = diffInfo.fabber_to_factory_ratio_basic;
        ai.personality.fabber_to_factory_ratio_advanced = diffInfo.fabber_to_factory_ratio_advanced;
        ai.personality.fabber_alone_on_planet_mod = diffInfo.fabber_alone_on_planet_mod;
        ai.personality.basic_to_advanced_factory_ratio = diffInfo.basic_to_advanced_factory_ratio;
        ai.personality.factory_alone_on_planet_mod = diffInfo.factory_alone_on_planet_mod;
        ai.personality.min_basic_fabbers = diffInfo.min_basic_fabbers;
        ai.personality.max_basic_fabbers = diffInfo.max_basic_fabbers;
        ai.personality.min_advanced_fabbers = diffInfo.min_advanced_fabbers;
        ai.personality.max_advanced_fabbers = diffInfo.max_advanced_fabbers;
        ai.personality.personality_tags = diffInfo.personality_tags

        //console.log("AI DIFF END: ");
      };

      var graph = new Graph(game.galaxy().gates())

      _.forEach(teamInfo, function (info) {
        if (info.boss) {
          setAIData(info.boss, maxDist, true);
          if( info.boss.minions )
            {
              _.forEach(info.boss.minions, function(minion)
                        {
                          setAIData(minion, maxDist, true);
                        });
            }

          var bossIndex = 0
          game.galaxy().stars().forEach(function(star, i) {
            if (star.ai() === info.boss) {
              bossIndex = i
            }
          })
          graph.calcDistance(bossIndex, function(i, d) {
            game.galaxy().stars()[i].bossDistance = d
          })
          var bossDist = _.reduce(info.workers, function (value, worker) {
            return Math.max(worker.star.bossDistance, value);
          }, 0);
        }
        var distBase = Math.floor(diffInfo.econBase / diffInfo.econRatePerDist)
        _.forEach(info.workers, function (worker) {
          var index = 0
          game.galaxy().stars().forEach(function(star, i) {
            if (star === worker.star) {
              index = i
            }
          })

          var dist = worker.star.distance() + maxDist - worker.star.bossDistance*2
          var absDist = distBase + dist
          var players = estimatePlayers(worker.star.system())
          var minMinions = Math.max(players[0] - 2, 0)
          var maxPlayers = Math.max(players[1] - 4, minMinions)
          var maxMinions = Math.min(maxPlayers, Math.floor(Math.pow(dist, 0.5)))
          var numMinions = 0
          var pow = 2
          var splitEffiency = 0.8
          var dists = [Math.pow(absDist, pow)]
          for (numMinions = 0;
               numMinions < maxMinions
               && (numMinions < minMinions || Math.random() < 0.6);
               numMinions++) {
            var n = Math.floor(Math.random() * dists.length)
            var v = dists[n] * splitEffiency
            var v1 = ((Math.random() + Math.random()) * 0.5 * (v-1) + 1)
            var v2 = (v - v1)
            dists[n] = v1
            dists.push(v2)
          }
          dists = dists.map(function(d) {
            return Math.floor(Math.pow(d, 1/pow) - distBase)
          })
          dists = dists.sort(function(a, b) { return b - a })

          /*
          var challenge = Math.pow(dists.map(function(dist) {
            return Math.pow(diffInfo.econBase + (dist * diffInfo.econRatePerDist), pow)
          }).reduce(function(a, b) {return a + b}, 0), 1/pow)
          console.log(players, absDist, challenge, dists.map(function(dist) {
            return diffInfo.econBase + (dist * diffInfo.econRatePerDist);
          }))
          */
          //console.log(dist, absDist, dists.slice(0))

          setAIData(worker.ai, dists.shift(), false);
          if (numMinions > 0) {
            worker.ai.minions = [];
            _.times(numMinions, function () {
              var mnn = _.sample(GWFactions[info.faction].minions);
              setAIData(mnn, dists.shift(), false);
              mnn.color = worker.ai.color;
              worker.ai.minions.push(mnn);
            });
          }
        });
      });

      var gw_intro_systems = [
        {
        name: "!LOC:The Progenitors",
        description: "!LOC:What little is clear is that the galaxy was once inhabited by a sprawling empire, seemingly destroyed by conflict. The commanders refer to these beings as The Progenitors. Many commanders believe answers to their origins lie within the ruins of this once great civilization."
      },
      {
        name: "!LOC:Galactic War",
        description: "!LOC:Some commanders fight because it's all they know, while others seek answers to their origins. Conflicts in motivation and creed drive the commanders into a war that is poised to ravage the galaxy for centuries."
      },
      {
        name: "!LOC:The Commanders",
        description: "!LOC:The commanders have slumbered for millions of years, and awaken to a galaxy that contains only echoes of civilization. These ancient war machines now battle across the galaxy, following the only directives they still hold from long ago."
      }
      ];

      var n = 0;
      _.forEach(game.galaxy().stars(), function(star) {
        var ai = star.ai();
        if (!ai) {
          var intro_system = gw_intro_systems[n];
          if (intro_system) {
            star.system().name = intro_system.name;
            star.system().description = intro_system.description;
            n = n + 1;
          }
        } else {
          star.system().display_name = ai.name; /* display name overrides name even after the ai dies */
          star.system().description = ai.description;
        }
      });

      if (model.creditsMode()) {
        var origin = game.galaxy().stars()[game.galaxy().origin()];
        origin.system().name = GWCredits.startSystem.name;
        origin.system().description = GWCredits.startSystem.description;
      }
    });

    var dealBossCards = finishAis.then(function () {
      return GWDealer.dealBossCards({
        galaxy: game.galaxy(),
        inventory: game.inventory()
      });
    });

    var deal = dealBossCards.then(function () {
      if (model.makeGameBusy() !== busyToken)
        return;

      model.makeGameBusy(false);
      model.newGame(game);
      model.updateCommander();
      return game;
    });
  }
  model.makeGameOrRunCredits();
})
