// Load modules

var Hapi = require('hapi');
var Rules = require('./rules');

// Declare internals

var internals = {};


// Tips cache

internals.tips = {};


// Pre-load all tips into cache

exports.initialize = function (db) {

    db.all('tip', function (err, results) {

        for (var i = 0, il = results.length; i < il; ++i) {
            var tip = results[i];
            if (tip.rule &&
                tip.text) {

                var statement = Rules.normalize(tip.rule);
                if (statement) {
                    tip.statement = statement;
                    internals.tips[tip._id] = tip;
                }
                else {
                    console.log('Failed to load tips: ' + tip._id);
                }
            }
            else {
                console.log('Bad tip: missing rule or text');
            }
        }
    });
};


// Analyze project and return tips list

exports.list = function (db, project, callback) {

    var results = [];

    for (var i in internals.tips) {
        if (internals.tips.hasOwnProperty(i)) {
            var tip = internals.tips[i];

            try {
                if (eval(tip.statement)) {
                    results.push({ id: tip._id, text: tip.text, context: tip.context });
                }
            }
            catch (e) {
                console.log('Bad tip rule:' + tip._id);
            }
        }
    }

    return callback(results);
};

