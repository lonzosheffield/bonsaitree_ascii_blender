#include <stdio.h>
#include <stdlib.h>
int main(void){
  unsigned int seeds[]={1u,42u,1337u,99999u,2147483647u,0u,4294967295u,7u};
  for(int s=0;s<8;s++){
    srand(seeds[s]);
    unsigned long long acc=1469598103934665603ULL; /* FNV-1a 64 */
    for(int i=0;i<100000;i++){
      int v=rand();
      unsigned char b[4]={(unsigned char)(v>>24),(unsigned char)(v>>16),(unsigned char)(v>>8),(unsigned char)v};
      for(int k=0;k<4;k++){acc^=b[k];acc*=1099511628211ULL;}
    }
    printf("%u %llu\n",seeds[s],acc);
  }
  return 0;
}
