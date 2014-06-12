/*
 * Breeze-MongoDb MongoSaveHandler processes Breeze saveChanges requests
 *
 * mongodb itself is not directly called by MongoSaveHandler
 * which relies instead upon the `db` instance passed into its ctor.
 * The handler assumes this is a mongodb node driver (v.1.4.5) `Db` instance
 * see http://mongodb.github.io/node-mongodb-native/api-generated/collection.html
 *
 * Copyright 2014 IdeaBlade, Inc.  All Rights Reserved.
 * Use, reproduction, distribution, and modification of this code is subject to the terms and
 * conditions of the IdeaBlade Breeze license, available at http://www.breezejs.com/license
 *
 * Author: Jay Traband, Ward Bell
 *
 */
var ObjectID = require('mongodb').ObjectID;

exports.MongoSaveHandler = MongoSaveHandler;

var MONGO_ERROR_CODE_DUP_KEY = 11000;

function MongoSaveHandler(db, reqBody, callback) {
    this.db = db;
    this.callback = callback;

    this.entities = reqBody.entities || [];
    this.metadata = reqBody.metadata || {};  // client can provide metadata; recommend overriding on the server
    this.hasServerMetadata = false;          // set true if you override client metadata
    this.saveOptions = reqBody.saveOptions;

    this.saveMap    = {};
    this.saveResult = {};

    this._insertedKeys = [];
    this._updatedKeys  = [];
    this._deletedKeys  = [];
    this._keyMappings  = [];
    this._entitiesCreatedOnServer = [];

    // semi-private members
    this._isDone = false;           // true when the save is done (good or bad) and have called this.callback
    this._allSaveCallsSent = false; // true when the last mongo save call has been sent
    this._saveCountPending = 0;     // the count of mongo save calls that have not yet returned
    this._keyMappings = [];
    this._possibleFixupMap = {};
}
var fn = MongoSaveHandler.prototype;

/////// Developer's pre-save configuration methods /////////
// Define or call these methods as needed prior to calling save();

// Adds a server-created entity-to-save to this.saveMap
fn.addToSaveMap = function(entity, entityTypeName, entityState) {
    entityTypeName = this.qualifyTypeName(entityTypeName);
    entity.entityAspect = {
        entityTypeName: entityTypeName,
        entityState: entityState || "Added",
        wasCreatedOnServer: true
    };

    var entityList = this.saveMap[entityTypeName];
    if (entityList) {
        entityList.push(entity);
    } else {
        this.saveMap[entityTypeName] = [ entity ];
    }

    return entity;
};

// DEVELOPER INTERCEPTORS - save interceptor methods that this handler
// looks for and executes. Add one more of them to this handler instance as needed.
// No default implementations
// -------------------------------------------------------------------
// `this.afterSaveEntity(done)` interceptor method - returns nothing
// Called after all mongo save operations have completed
// Be sure to check this.saveResult.errors because some or all of the saves may have failed
// Call 'done' after doing your thing.
// Call 'this._raiseError(err) to report your own error to the client
// remembering to set `err.saveResult=this.saveResult;`
// so client knows which entities were saved and which were not.
// 'this' is bound to the current saveHandler instance
fn.afterSaveEntities = undefined;

// `this.beforeSaveEntity(entity)` interceptor method - returns true if should save the entity
// Called for each individual entity in the client save request
// 'this' is bound to the current saveHandler instance
fn.beforeSaveEntity = undefined;

// `this.beforeSaveEntities(continuerSave)` interceptor method - returns nothing
// Called after 'this.saveMap` has been loaded with the entities to save
// after `beforeSaveEntity` voted on them and before the breeze save processing.
// Can evaluate 'this.saveMap' which is a hash of entities to save,
// keyed by entityType,  with each value being an array of entities of that type.
// Call 'continueSave' after doing your thing ... assuming you want to continue
// else call 'this._raiseError(err) to report error to the client
// 'this' is bound to the current saveHandler instance
fn.beforeSaveEntities = undefined;

fn.registerEntityType= function(entityTypeName, mongoCollectionName, autoGeneratedKeyType, dataProperties ) {
    entityTypeName = this.qualifyTypeName(entityTypeName);
    var entityType = this.metadata[entityTypeName];
    if (!entityType) {
        entityType = { name: entityTypeName };
        this.metadata[entityTypeName] = entityType;
    }
    entityType.collectionName = mongoCollectionName;
    entityType.defaultResourceName = mongoCollectionName || entityType.defaultResourceName;
    entityType.autoGeneratedKeyType = autoGeneratedKeyType || entityType.autoGeneratedKeyType || "None";
    entityType.dataProperties = dataProperties || entityType.dataProperties || [];
};

fn.qualifyTypeName = function(entityTypeName) {
    if ((entityTypeName.indexOf(":#") !== -1) || (!this.metadata.defaultNamespace)) {
        return entityTypeName;
    } else {
        return entityTypeName + ":#" + this.metadata.defaultNamespace;
    }
};

////////// save() and its helpers ///////////////

MongoSaveHandler.save = function(db, reqBody, callback) {
    var saveHandler = new MongoSaveHandler(db, reqBody, callback);
    saveHandler.save();
};

fn.save = function() {
    if (this._buildSaveMap()) return;
    var saveCoreFn = saveCore.bind(this);
    if (this.beforeSaveEntities) {
        try {
            this.beforeSaveEntities.bind(this)(saveCoreFn);
        } catch (err){
            err.message = "save failed in 'beforeSaveEntities' with error '"+err.message+"'";
            this._raiseError(err);
        }
    } else {
        saveCoreFn();
    }
};

// 'this' is bound to MongoSaveHandler instance at runtime (see fn.save())
function saveCore() {
    this._reviewMetadata();
    if (this._isDone) { return; }
    var collectionSaveDocs = [];
    this._prepareCollectionSaveDocs(collectionSaveDocs);
    this._fixupFks(collectionSaveDocs);
    this._saveCollections(collectionSaveDocs);
}

fn._buildSaveMap = function (){
    var beforeSaveEntity = this.beforeSaveEntity && this.beforeSaveEntity.bind(this);
    var kf1 = function(e) { return e.entityAspect.entityTypeName;};
    var kf2 = function(e) { return beforeSaveEntity(e) ? kf1(e) : undefined; };
    var keyFn =  beforeSaveEntity ? kf2 : kf1;
    var errPrefix = "save failed in 'beforeSaveEntity'";
    return this._groupBy(this.entities, keyFn, this.saveMap = {}, errPrefix);
};

fn._coerceData = function(entity, entityType) {
    var _this = this;

    var errPrefix = function(e){
        return "Save failed checking data for "+entityType.entityTypeName+".id_: "+e._id;
    };

    var deleteNulls=true, // consider option to keep them if really wanted
        props = entityType.dataProperties;
    switch (entity.entityAspect.entityState){
        case "Added":
            // nothing more to do
            break;
        case "Modified":
            if (entity.entityAspect.forceUpdate){
                deleteNulls = false; // need them to clear an existing property value
            } else {
                // Coerce only the _id and original values properties
                // because those are only properties involved in update
                var ovm = entity.entityAspect.originalValuesMap;
                props = props.filter(function(dp){
                    return ovm.hasOwnProperty(dp.name);
                });
                props.push(entityType.key);
            }
            break;
        case "Deleted":
            props = [entityType.key];
            break;
        default:
            var msg = errPrefix(entity) + ". Unknown save operation request, entityState = " +
                entity.entityAspect.entityState;
            _this._raiseError({statusCode: 400, message: msg});
            return;
    }

    return _this._forEach(props, coerceProp, errPrefix);

    function coerceProp(dp) {
        var msg;
        var dt = dp.dataType;
        var dpn = dp.name;
        var val = entity[dpn];
        // if this is an fk column and it has a value
        // create a map of entities that may need to be fixed up - keyed by the tempFkValue ( which may be a realFkValue already).
        // Note this works because in mongo all fkValues must refer to an _id field as the paired key.
        if (dp.isFk && val) {
            var fk = entity[dpn];
            var fus = _this._possibleFixupMap[fk];
            if (!fus) {
                _this._possibleFixupMap[fk] = fus = [];
            }
            fus.push( { _id: entity._id, fkProp: dpn  });
        }
        if (val == null) {
            if (deleteNulls) { delete entity[dpn]; }
            return;
        }
        // assertion: val is not null at this point
        try {
            if (dt === "MongoObjectId") {
                entity[dpn] = ObjectID.createFromHexString(val);
            } else if (dt === "DateTime" || dt === "DateTimeOffset") {
                entity[dpn] = new Date(Date.parse(val));
            }
        } catch (err) {
            msg = errPrefix(e) +
            ". Unable to convert the "+dpn+" value: '" + val + "' to a "+dt;
            _this._raiseError({statusCode: 400, message: msg});
        }
    }
};

// 'collectionSaveDocs' - the insert/update/delete documents for each collection
fn._fixupFks = function(collectionSaveDocs) {
    var _this = this;
    try {
        if (this._isDone) { return true; }// stop processing
        if (this._keyMappings.length === 0) { return false; }// continue processing
        fixup();
        return false;
    } catch (err){
        this._raiseError(err);
        return true;
    }

    function fixup(){
        // pendingMap is a map of _id-to-pendingDoc
        // for all inserts and updates
        var pendingMap = {};
        collectionSaveDocs.forEach(function(cd) {
            cd.inserts.concat(cd.updates)
                .forEach(function(doc) {
                    pendingMap[doc.entityAspect.entityKey._id] = doc;
                })
        });

        // kmMap is a map of tempFkValue -> keyMapping
        var kmMap = {};
        _this._keyMappings.forEach(function(km) {
            kmMap[km.tempValue] = km;
        });

        // _possibleFixupMap is a map of fkValue -> [] of possibleFixups { _id:, fkProp: }
        for (var fkValue in _this._possibleFixupMap) {
            var km = kmMap[fkValue];
            if (km) {
                // if we get to here we know that we have an fk or fks that need updating
                var realValue = km.realValue;
                var pendingFixups = _this._possibleFixupMap[fkValue];
                pendingFixups.forEach(function(pendingFixup) {
                    // update the pendingDoc with the new real fkValue
                    // next line is for debug purposes
                    pendingFixup.fkValue = realValue;
                    var pendingDoc = pendingMap[pendingFixup._id];
                    if (pendingDoc.criteria) {
                        pendingDoc.setOps.$set[pendingFixup.fkProp] = realValue;
                    } else {
                        pendingDoc.entity[pendingFixup.fkProp] = realValue;
                    }
                });
            }
        }
    }
};

fn._prepareCollectionSaveDocs = function(collectionSaveDocs){
    if (this._isDone) { return true; }
    var _this = this;

    var entityTypeNames = Object.keys(this.saveMap || {});

    var makeSaveDocs = function(entityTypeName){
        var docs = _this.__prepareCollectionSaveDocsForType(entityTypeName);
        collectionSaveDocs.push(docs);
    };

    return this._forEach(entityTypeNames, makeSaveDocs)
};

// For entities of a given EntityType
// return the insert/update/delete save documents for the corresponding collection
fn.__prepareCollectionSaveDocsForType = function(entityTypeName) {
    var entities = this.saveMap[entityTypeName];
    var entityType = this.metadata[entityTypeName];
    var insertDocs = [];
    var updateDocs = [];
    var deleteDocs = [];

    var _this = this;
    var errPrefix = function(e){
        return "Save failed preparing save docs for "+entityType.entityTypeName+".id_: "+e._id;
    };
    _this._forEach(entities, prepEntity, errPrefix);

    return {
        entityType: entityType,  // for debugging
        collectionName:  entityType.collectionName,
        inserts: insertDocs,
        updates: updateDocs,
        deletes: deleteDocs
    };

    function prepEntity(e) {
        var msg;
        // Coerce before using _id because that's one of the properties it parses
        _this._coerceData(e, entityType);

        // hold entityAspect because we must strip it from an inserted entity.
        var entityAspect = e.entityAspect;
        entityAspect.entity = e;

        var entityKey = { entityTypeName: entityTypeName, _id: e._id };
        entityAspect.entityKey = entityKey;

        var criteria;

        switch(entityAspect.entityState) {
            case "Added":
                var autoGeneratedKeyType = entityType.autoGeneratedKeyType;
                if (autoGeneratedKeyType && autoGeneratedKeyType !== "None") {

                    var keyDataType = entityType.keyDataType;
                    if (keyDataType === "Guid") {
                        e._id = createGuid();
                    } else if (keyDataType == "MongoObjectId") {
                        // instead of omitting the _id and having mongo update it, we want to set it ourselves so that we can do
                        // fk fixup before going async
                        e._id = new ObjectID();
                    } else {
                        msg = errPrefix(e) +
                             ". ObjectIds and Guids are the only autoGenerated key types that Breeze currently supports, not " + keyDataType;
                        _this._raiseError({statusCode: 400, message: msg});
                        return;
                    }
                }

                // entityKey._id may be null/undefined for entities created only on the server side - so no need for keyMapping
                if (entityKey._id == null) {
                    entityKey._id = e._id;
                } else if (entityKey._id !== e._id) {
                    var keyMapping = { entityTypeName: entityTypeName, tempValue: entityKey._id, realValue: e._id };
                    _this._keyMappings.push(keyMapping);
                }

                delete e.entityAspect; // Don't want to insert that!
                var insertDoc = {
                    entity: e,
                    entityAspect: entityAspect
                };
                insertDocs.push(insertDoc);
                break;

            case "Modified":
                criteria = { "_id": e._id };
                if (entityType.concurrencyProp) {
                    // Note that the Breeze client will ensure that the current value has been updated.
                    // so no need to do that here
                    var propName = entityType.concurrencyProp.name;
                    criteria[propName] = entityAspect.originalValuesMap[propName];
                }
                var setMap = {};
                if (entityAspect.forceUpdate) {
                    setMap = extend({}, e);
                    // remove fields that we don't want to 'set'
                    delete setMap.entityAspect;
                    delete setMap._id;
                } else {
                    Object.keys(entityAspect.originalValuesMap).forEach(function (k) {
                        setMap[k] = e[k];
                    });
                }

                var updateDoc = {
                    criteria: criteria,
                    setOps: { $set: setMap },
                    entityAspect: entityAspect,
                    hasConcurrencyCheck: !!entityType.concurrencyProp
                };
                updateDocs.push(updateDoc);
                break;

            case "Deleted":
                criteria = { "_id": e._id };
                // we don't bother with concurrency check on deletes
                // TODO: we may want to add a 'switch' for this later.
                var deleteDoc = {
                    criteria: criteria,
                    entityAspect: entityAspect
                };
                deleteDocs.push(deleteDoc);
                break;
            default:
                msg = errPrefix(e) + ". Unknown save operation request, entityState = " + entityAspect.entityState;
                _this._raiseError({statusCode: 400, message: msg});
                return;
        }
    }
};

// Validate and massage the save metadata
// N.B. Will set metadata object values even when this.hasServerMetadata == true
//      Make sure the changes don't 'corrupt' your source of metadata, including:
//      * entityType.collectionName
//      * entityType.key
//      * entityType.keyDataType
//      * entityType.concurrencyProp
fn._reviewMetadata = function (){
    var _this = this;
    return _this._forEach(Object.keys(this.saveMap), reviewType);

    function reviewType(typeName) {
        var msg;
        var entityType = _this.metadata[typeName];
        if (!entityType) {
            msg = "Unable to locate metadata for an EntityType named: " + typeName;
            _this._raiseError({statusCode: 400, message: msg});
            return null;
        }

        entityType.collectionName = entityType.collectionName || entityType.defaultResourceName;

        return _this._forEach(entityType.dataProperties, reviewProperties);

        function reviewProperties(dp) {
            var dt = dp.dataType;

            if (dp.name === "_id") {
                entityType.key         = dp;
                entityType.keyDataType = dt;

                if (dp.isFk) {
                    msg = "The '" + typeName + "._id' property cannot itself be a foreignKey in a mongoDb - Please check your metadata.";
                    _this._raiseError(new Error(msg));
                    return
                }
            }
            if (dp.isConcurrencyProp) {
                entityType.concurrencyProp = dp;
            }
        }
    }
};

fn._saveCollections = function(collectionSaveDocs){
    if (this._isDone) {return true; }
    this.saveResult = {
        insertedKeys: this._insertedKeys,
        updatedKeys:  this._updatedKeys,
        deletedKeys:  this._deletedKeys,
        keyMappings:  this._keyMappings,
        entitiesCreatedOnServer: this._entitiesCreatedOnServer,
        errors: []
    };
    if (collectionSaveDocs.length === 0) {
        this._invokeCompletedCallback();
    } else {
        // once we start saving to mongo, we have to do them all.
        collectionSaveDocs.forEach(this._saveCollection.bind(this));
        this._allSaveCallsSent = true; // all mongo calls have been sent
    }
    return this._isDone;
};

// 'cd' is a 'collectionSaveDoc' - the insert/update/delete documents for a collection
// See driver Collection documentation: http://mongodb.github.io/node-mongodb-native/api-generated/collection.html
fn._saveCollection = function(cd) {
    this._saveCountPending += cd.inserts.length + cd.updates.length + cd.deletes.length;
    var saveOptions = { safe: true };
    var _this = this;
    this.db.collection(cd.collectionName, {strict: true} , function (err, collection) {
        if (err) {
            err.message = err.message.replace(/ Currently in safe mode\./,'');
            var msg = "Save failed to find the db collection for '" + cd.entityType.entityTypeName +
                      "' because " + err.message;
            err = { statusCode: 400, message: msg, error: err };
            _this._catchSaveError(err);
            return;
        }

        cd.inserts.forEach(function (iDoc) {
            collection.insert(iDoc.entity, saveOptions, function(err, insertedObjects) {
                _this._handleInsert(iDoc, err, insertedObjects);
            });
        });
        cd.updates.forEach(function (uDoc) {
            collection.update( uDoc.criteria, uDoc.setOps, saveOptions, function(err, wasUpdated) {
                _this._handleUpdate(uDoc, err, wasUpdated);
            })
        });
        cd.deletes.forEach(function (dDoc) {
            collection.remove( dDoc.criteria, true, function(err, numberRemoved) {
                _this._handleDelete(dDoc, err, numberRemoved);
            })
        });
    });
};

fn._handleInsert = function(insertDoc, err, insertedObjects) {
    try {
        if (err) {
            if (err.code == MONGO_ERROR_CODE_DUP_KEY) {
                err.statusCode = 409;
                err.message = "Duplicate key.";
            }
            this._catchSaveError(err, insertDoc);
            return;
        }
        var count = Array.isArray(insertedObjects) ? insertedObjects.length : 0;
        if (count !== 1) {
            err = {message: "Expected exactly 1 inserted doc; db inserted "+count};
            this._catchSaveError(err, insertDoc);
            return;
        }
        this._handleSave(insertDoc, this._insertedKeys);
    } catch (e){
        this._catchSaveError(e, insertDoc);
    }
};

fn._handleUpdate = function (updateDoc, err, wasUpdated) {
    try {
        if (this._checkIfSaveError(err, updateDoc)) return;
        if (!wasUpdated) {
            var msg = "Not updated. ";
            if (updateDoc.hasConcurrencyCheck){
                msg +="Perhaps not found due to the concurrency check.";
            }
            err = {statusCode: 404, message: msg};
            this._catchSaveError(err, updateDoc);
            return;
        }
        this._handleSave(updateDoc, this._updatedKeys);
    } catch (e){
        this._catchSaveError(e, updateDoc);
    }
};

fn._handleDelete = function (deleteDoc, err, numberRemoved) {
    try {
        if (this._checkIfSaveError(err, deleteDoc)) return;
        if (numberRemoved !== 1) {
            var msg = "Not deleted; may have been deleted previously.";
            if (deleteDoc.hasConcurrencyCheck){
                msg +=" Perhaps not found due to the concurrency check.";
            }
            err = {statusCode: 404, message: msg};
            this._catchSaveError(err, deleteDoc);
            return;
        }
        this._handleSave(deleteDoc, this._deletedKeys);
    } catch (e){
        this._catchSaveError(e, deleteDoc);
    }
};

// Called last in a save handler when we know the doc was saved
fn._handleSave = function(doc, keyCollection) {
    var entityAspect = doc.entityAspect;
    var entityKey = entityAspect.entityKey;
    if (entityAspect.wasCreatedOnServer) {
        var entity = entityAspect.entity;
        entity.$type = entityAspect.entityTypeName;
        this._entitiesCreatedOnServer.push(entity);
    }
    keyCollection.push(entityKey);
    this._checkIfCompleted();
};

/////// UTILITIES ///////

fn._checkIfSaveError = function(err, doc) {
    if (err) {
        this._catchSaveError(err, doc);
        return true;
    }
    return false;
};

fn._catchSaveError = function(err, doc){
    var entry = {
        status:  err.statusCode || err.status || 500,
        message: err.message
    };
    if (doc){
        var aspect = doc.entityAspect;
        entry.entityKey   = aspect.entityKey;
        entry.entityState = aspect.entityState;
    }
    this.saveResult.errors.push(entry);
    this._checkIfCompleted();
};

// Called within a saveCollection callback
fn._checkIfCompleted = function() {
    if (this._isDone) return;               // already terminated the entire saveChanges operation
    this._saveCountPending -= 1;            // this save call is done; decrement the count
    if (this._saveCountPending > 0) return; // awaiting more mongoDb save results
    if (!this._allSaveCallsSent) return;    // might not have sent all mongoDb calls yet
    this._invokeCompletedCallback();        // we really ARE done; wrap up the save
};

// Safe array iterator
// Terminates if f() raises or throws error.
// f() can _raiseError() with status other than 500.
// errPrefix says what you were trying to do when exception was thrown
// it is either a string or a function that takes the current iterated value and returns a string
// Returns TRUE if caller should STOP (false to continue)
fn._forEach = function(src, f, errPrefix){
    if (this._isDone) { return true; }
    try {
        for (var i=0, len=src.length; i < len; i++){
            f(src[i]);
            if (this._isDone) { return true; }
        }
    } catch (err){
        var callErrPrefix = function(){
            try { return errPrefix(src[i]);}
            catch (e){ return '';}
        };
        var pre = typeof errPrefix === 'function' ? callErrPrefix() : errPrefix ;
        err.message = (pre || 'Save failed') +  ' with error: ' + err.message;
        this._raiseError(err);
        return true;
    }
    return false;
};

// Safely iterate over array pushing values into arrays in
// the 'groups' object grouped by the key returned from keyFn()
// kvFn(key, value) turns key and value into a result to push
// Terminates if keyFn() raises or throws error.
// keyFn() can _raiseError() with status other than 500.
// Returns TRUE if caller should STOP (false to continue)
fn._groupBy = function(arr, keyFn, groups, errPrefix) {
    groups = groups || {};
    return this._forEach(arr, grouper, errPrefix);

    function grouper (v) {
        var key = keyFn(v);
        if (key !== undefined) {
            var group = groups[key];
            if (group){
                group.push(v)
            } else {
                groups[key] = [v];
            }
        }
    }
};

// called when all mongo save operations have completed
fn._invokeCompletedCallback=function() {

    var done = function (){
        var sr = this.saveResult;
        if (sr.errors.length === 0) {
            this._isDone = true;
            this.callback(null, sr);
        } else {
            this._raiseError( {
                statusCode: 400,
                message: "Some entities were not saved; see the errors array.",
                saveResult: sr
            });
        }
    }.bind(this);

    if (this.afterSaveEntities) {
        try {
            this.afterSaveEntities.bind(this)(done);
        } catch (err){
            err.message = "Save failed in 'afterSaveEntities' with error '"+err.message+"'";
            err.saveResult = this.saveResult;
            this._raiseError(err);
        }
    } else {
        done();
    }
};

fn._raiseError = function(error) {
    if (this._isDone) return;
    this._isDone = true;
    this.callback(error);
};

///// Private functions //////
function createGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function extend(target, source) {
    if (!source) return target;
    for (var name in source) {
        if (source.hasOwnProperty(name)) {
            target[name] = source[name];
        }
    }
    return target;
}
