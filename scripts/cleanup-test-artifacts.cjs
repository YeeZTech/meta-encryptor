#!/usr/bin/env node
'use strict';

const { cleanupAll, cleanupStaleRootArtifacts, cleanupTestTmpRoot } = require('../test/tempRegistry.cjs');

cleanupStaleRootArtifacts();
cleanupAll();
cleanupTestTmpRoot();
console.log('Removed test artifacts from project root and test_tmp/');
