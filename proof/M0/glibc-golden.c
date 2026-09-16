/* Emit the first N values of glibc rand() for a set of seeds.
 * Mirrors exactly what vendor/cbonsai/cbonsai.c:1062 does: srand(seed) then bare rand().
 */
#include <stdio.h>
#include <stdlib.h>
#include <gnu/libc-version.h>

#define NVALS 200

int main(void) {
    unsigned int seeds[] = {1u, 42u, 1337u, 99999u, 2147483647u};
    int nseeds = (int)(sizeof(seeds) / sizeof(seeds[0]));

    printf("# glibc rand() golden vectors\n");
    printf("# glibc version: %s\n", gnu_get_libc_version());
    printf("# RAND_MAX: %d\n", RAND_MAX);
    printf("# format: seed <S> then %d values, one per line, in call order\n", NVALS);

    for (int s = 0; s < nseeds; s++) {
        srand(seeds[s]);
        printf("seed %u\n", seeds[s]);
        for (int i = 0; i < NVALS; i++) {
            printf("%d\n", rand());
        }
    }
    return 0;
}
