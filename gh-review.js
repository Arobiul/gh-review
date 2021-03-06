#!/usr/bin/env node

"use strict";

var program = require('commander');
var fs = require('fs-extra');
var glob = require('glob');
var async = require('async');
var colors = require('colors');
var lineCount = require('line-count');
var _ = require('underscore');
var Github = require('github-api');
var GitHubApi = require("github");
var Table = require('cli-table');
var Git = require("nodegit");

var ASYNC_LIMIT = 10

program
    .version('0.1.0')
    .arguments('<organisationName>')
    .description('Review the status of an organisations public github account and score it based on documents present (like READMEs)')
    .option('-u, --username <username>', 'GitHub Username (Optional)')
    .option('-p, --password <password>', 'GitHub Password (Optional)')
    .option('-o, --oauth <oauth>', 'OAuth2 token to authenticate with (Optional)')
    .option('-i, --createIssues', 'Create issues for the problems identified, requires authentication (Optional)')
    .option('-s, --publicOnly', 'Public only, even if authenticated (Optional)')
    .parse(process.argv);

if ((!program.username && program.password) || (program.username && !program.password) || program.args.length != 1 || (program.createIssues && !((program.username && program.password) || program.oauth) )) {
    program.help();
}

var auth = {};

if (program.oauth) {
    auth = {
        token: program.oauth,
        auth: "oauth",
        type: "oauth"
    };
}

if (program.username && program.password) {
    auth = {
        username: program.username,
        password: program.password,
        auth: "basic",
        type: "basic"
    };
}

var github = new Github(auth);
var alternativeGithub = new GitHubApi({
    // required
    version: "3.0.0",
    // optional
    debug: false,
    protocol: "https",
    host: "api.github.com", // should be api.github.com for GitHub
    pathPrefix: "", // for some GHEs; none for GitHub
    timeout: 5000,
    headers: {
        "user-agent": "gh-review" // GitHub is happy with a unique user agent
    }
});

if (Object.keys(auth).length != 0) {
    alternativeGithub.authenticate(auth);
}

var user = github.getUser();


var orgname = program.args[0];

var tmpDirectory = "/tmp/gh-review-" + process.pid;

var cloneOptions = {
    fetchOpts: {
        callbacks: {
            certificateCheck: function () {
                return 1;
            },
            credentials: function (url, userName) {
                if (program.oauth) {
                    return Git.Cred.userpassPlaintextNew(userName, program.oauth);
                }
                if (program.username) {
                    return Git.Cred.userpassPlaintextNew(program.username, program.password);
                }

                return Git.Cred.sshKeyFromAgent(userName);
            }
        }
    }
};


console.log("Requesting Repos for: " + orgname);
user.orgRepos(orgname, function (er, repos) {
    if (er) {
        console.error(er);
        process.exit(1);
    }

    async.filterLimit(repos, ASYNC_LIMIT, function (repo, callback) {
        if (program.publicOnly && repo.private) {
            callback(false)

        } else {
            callback(true);
        }
    }, function (repos) {

        async.forEachOfLimit(repos, ASYNC_LIMIT, function (repo, key, callback) {
                console.log("Checking out: " + repo.full_name);

                var repoLocation = tmpDirectory + "/" + repo.id;
                var cloneRepository = Git.Clone(repo.clone_url, repoLocation, cloneOptions);

                cloneRepository.catch(console.log.bind(console)).then(function (repository) {
                    console.log("Analysing: " + repo.full_name);
                    async.parallelLimit({
                        readme: function (callback) {
                            glob("README*", {cwd: repoLocation}, function (er, files) {
                                // GH Generates a tiny readme for you. Most readmes are greater than 10 lines.
                                // Lets check for that
                                if (files.length > 0) {
                                    async.someLimit(files, ASYNC_LIMIT, function (file, callback) {
                                        var fileContents = fs.readFileSync(repoLocation + "/" + file, {encoding: 'utf8'});

                                        if (!fileContents) {
                                            callback(false);
                                        }
                                        else {
                                            callback(lineCount(fileContents) > 10)
                                        }
                                    }, function (result) {
                                        callback(er, result);
                                    });
                                }
                                else {
                                    callback(er, false);
                                }
                            })
                        },
                        license: function (callback) {
                            glob("LICENSE*", {cwd: repoLocation}, function (er, files) {
                                callback(er, files.length > 0)
                            })
                        },
                        contributing: function (callback) {
                            glob("CONTRIBUTING*", {cwd: repoLocation}, function (er, files) {
                                callback(er, files.length > 0)
                            })
                        },
                        travis: function (callback) {
                            glob(".travis.yml", {cwd: repoLocation}, function (er, files) {
                                callback(er, files.length > 0)
                            })
                        }

                    }, ASYNC_LIMIT, function (er, status) {
                        if (er) {
                            console.error(er);
                            process.exit(1);
                        }

                        repos[key] = _.extend(repo, status, {checkout_location: repoLocation});

                        callback(er);
                    })
                });
            }, function (er) {
                if (er) {
                    console.error(er);
                    process.exit(1);
                }

                fs.remove(tmpDirectory);

                var calculateScore = function (repo, callback) {
                    var score = 0;
                    score += repo.readme;
                    score += repo.license;
                    score += repo.contributing;

                    score += repo.travis;

                    repo.score = score;
                    callback(null, repo);
                };

                console.log("Calculating scores");

                if (program.createIssues) {
                    console.log("& Posting Issues");
                    var postIssue = function (issues, repo, title, description, callback) {
                        async.filterLimit(issues, ASYNC_LIMIT, function (issue, callback) {
                            callback(issue.title == title);
                        }, function (results) {
                            if (results && results.length == 0) {
                                alternativeGithub.issues.create({
                                    title: title,
                                    body: description,
                                    user: repo.owner.login,
                                    repo: repo.name
                                }, function (er, result) {
                                    if (er) {
                                        console.error(er);
                                    }

                                    callback(null, result);
                                });

                                console.log("Posting issue on " + repo.full_name + " about \"" + title + "\"")
                            }
                            else {
                                callback(null, results)
                            }
                        })
                    };

                    async.eachLimit(repos, 1, function (repo, callback) {
                        console.log(repo);
                        console.log(repo.full_name);

                        github.getIssues(repo.owner.login, repo.name).list({}, function (err, issues) {
                            if (err) {
                                console.log(err);
                            }

                            async.series([function (callback) {
                                if (!repo.readme) {
                                    postIssue(
                                        issues,
                                        repo,
                                        "Missing Good Readme",
                                        "A project is useless without a good readme. See here for a guide: https://gist.github.com/PurpleBooth/6f1ba788bf70fb501439, and here for an example https://gist.github.com/PurpleBooth/109311bb0361f32d87a2",
                                        callback
                                    )
                                }
                                else {
                                    callback()
                                }
                            }, function (callback) {
                                if (!repo.license) {
                                    postIssue(
                                        issues,
                                        repo,
                                        "Missing a License",
                                        "Without a license a user cannot use a project as they might be sued! See here for a guide: https://gist.github.com/PurpleBooth/6f1ba788bf70fb501439, and here for an example https://github.com/nevir/readable-licenses/tree/master/markdown",
                                        callback
                                    )
                                }
                                else {
                                    callback()
                                }
                            }, function (callback) {
                                if (!repo.contributing) {
                                    postIssue(
                                        issues,
                                        repo,
                                        "Missing a CONTRIBUTING file",
                                        "A contributing file is a place for a user to work out how to contribute to a project, and what coding standards, and things they need to do before submitting code. It is also the place you should include a code of conduct, to make sure people know they can be expected to be treated fairly by the project. https://gist.github.com/PurpleBooth/6f1ba788bf70fb501439",
                                        callback
                                    )
                                }
                                else {
                                    callback()
                                }
                            }, function (callback) {
                                if (!repo.travis) {
                                    postIssue(
                                        issues,
                                        repo,
                                        "Missing a travis ci config",
                                        "Make life easier for people submitting code to your repository. Make sure that you double check that their code works the best you can (even if that's just running a build of the package) in travis. This way potential contributors can fix bugs before you even need to look at their request. https://gist.github.com/PurpleBooth/6f1ba788bf70fb501439",
                                        callback
                                    )
                                }
                                else {
                                    callback()
                                }
                            }
                            ], function (err, results) {
                                if (err) {
                                    console.log(err);
                                }

                                callback(err);
                            })
                        })
                    }, function (err) {
                    });
                }

                async.mapLimit(repos, ASYNC_LIMIT, calculateScore, function (er, repos) {
                    if (er) {
                        console.error(er);
                        process.exit(1);
                    }

                    repos.sort(function (a, b) {
                        if (a.score > b.score) {
                            return 1
                        }
                        if (a.score < b.score) {
                            return -1
                        }

                        if (a.full_name > b.full_name) {
                            return 1
                        }
                        if (a.full_name < b.full_name) {
                            return -1
                        }

                        return 0;
                    });

                    var prettyTicks = function (repo, callback) {
                        repo.readmeOut = repo.readme ? "✓".green : "✗".red;
                        repo.licenseOut = repo.license ? "✓".green : "✗".red;
                        repo.contributingOut = repo.contributing ? "✓".green : "✗".red;
                        repo.travisOut = repo.travis ? "✓".green : "✗".red;
                        repo.privateOut = repo.private ? "private" : "public";

                        callback(null, repo);
                    };

                    async.mapLimit(repos, ASYNC_LIMIT, prettyTicks, function (er, repos) {
                        if (er) {
                            console.error(er);
                            process.exit(1);
                        }

                        var table = new Table({
                            head: ['Name', 'Private', 'README', 'LICENSE', 'CONTRIBUTING', 'Travis', 'Score']
                        });

                        repos.forEach(function (repo) {
                            table.push([repo.full_name, repo.privateOut, repo.readmeOut, repo.licenseOut, repo.contributingOut, repo.travisOut, repo.score])
                        });

                        console.log(table.toString());
                    });
                });
            }
        )
    });
});
