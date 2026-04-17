// cli-jaw native launcher — preserves bundle identity for macOS TCC.
// Built to Contents/MacOS/jaw-launcher (Mach-O, not a shell script).
// A shell-shim launcher routes AppleEvents responsibility to /bin/bash,
// which breaks TCC attribution. Keeping this as a native binary is the
// whole reason it exists — do not port to a script.

#import <Foundation/Foundation.h>

#ifndef PINNED_PATH
#define PINNED_PATH "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
#endif

static NSString *JawFindInPath(NSString *binary, NSArray<NSString *> *dirs) {
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *dir in dirs) {
        if (dir.length == 0) continue;
        NSString *candidate = [dir stringByAppendingPathComponent:binary];
        if ([fm isExecutableFileAtPath:candidate]) {
            return candidate;
        }
    }
    return nil;
}

static void JawLog(NSString *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    NSString *line = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    fprintf(stderr, "[jaw-launcher] %s\n", line.UTF8String);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        const char *override = getenv("CLI_JAW_PATH_OVERRIDE");
        const char *pinned = (override && override[0]) ? override : PINNED_PATH;
        setenv("PATH", pinned, 1);

        NSArray<NSString *> *dirs = [[NSString stringWithUTF8String:pinned]
                                      componentsSeparatedByString:@":"];
        NSString *cliJaw = JawFindInPath(@"cli-jaw", dirs);
        NSString *node   = JawFindInPath(@"node", dirs);

        if (!cliJaw || !node) {
            JawLog(@"cli-jaw or node not found in PATH=%s", pinned);
            return 127;
        }

        NSMutableArray<NSString *> *args = [NSMutableArray arrayWithObjects:cliJaw, @"serve", nil];
        for (int i = 1; i < argc; i++) {
            [args addObject:[NSString stringWithUTF8String:argv[i]]];
        }

        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:node];
        task.arguments = args;

        NSError *err = nil;
        if (![task launchAndReturnError:&err]) {
            JawLog(@"launch failed: %@", err.localizedDescription ?: @"unknown");
            return 1;
        }
        [task waitUntilExit];
        return task.terminationStatus;
    }
}
