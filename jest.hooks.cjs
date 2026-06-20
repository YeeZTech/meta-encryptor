const { cleanupStaleRootArtifacts, installJestHooks } = require('./test/tempRegistry.cjs');

cleanupStaleRootArtifacts();
installJestHooks();
