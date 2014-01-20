// Load modules

var Hoek = require('hoek');
var Db = require('./db');
var Stream = require('./stream');
var Session = require('./session');
var Routes = require('./routes');
var Suggestions = require('./suggestions');
var Tips = require('./tips');


// Declare internals

var internals = {};


exports.register = function (plugin, options, next) {

    // tos: 20110623

    var database = new Db(options);

    plugin.bind({
        config: options.config,
        vault: options.vault,
        db: database
    });

    plugin.loader(require);
    plugin.require('scarecrow', function (err) {

        Hoek.assert(!err, 'Failed loading plugin: ' + err);

        plugin.auth.strategy('oz', 'oz', true, {
            oz: {
                encryptionPassword: options.vault.ozTicket.password,
                loadAppFunc: Session.loadApp(database),
                loadGrantFunc: Session.loadGrant(database)
            }
        });

        plugin.ext('onPreResponse', internals.onPreResponse);
        plugin.route(Routes.endpoints);

        database.initialize(function (err) {

            if (err) {
                console.log(err);
                process.exit(1);
            }

            Suggestions.initialize(database);
            Tips.initialize(database);
            plugin.events.on('start', function () {

                Stream.initialize(plugin.servers[0].listener);
            });
        });
    });

    return next();
};

// Post handler extension middleware

internals.onPreResponse = function (request, reply) {

    var response = request.response;
    if (!response.isBoom &&
        response.variety === 'plain' &&
        response.source instanceof Array === false) {

        // Sanitize database fields

        var payload = response.source;

        if (payload._id) {
            payload.id = payload._id;
            delete payload._id;
        }

        for (var i in payload) {
            if (payload.hasOwnProperty(i)) {
                if (i[0] === '_') {
                    delete payload[i];
                }
            }
        }
    }

    return reply();
};
