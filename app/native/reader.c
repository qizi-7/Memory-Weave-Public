#include "sqlite3.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <math.h>
#define RESPONSE_BUDGET (16u*1024u*1024u)
// Validate UTF-8 before JSON serialization. Invalid bytes travel losslessly as $hex.
static int utf8(const unsigned char *s,int n){
 for(int i=0;i<n;){unsigned c=s[i++],v;int k;
  if(c<128)continue;
  if(c>=0xc2&&c<=0xdf){v=c&31;k=1;}
  else if(c>=0xe0&&c<=0xef){v=c&15;k=2;}
  else if(c>=0xf0&&c<=0xf4){v=c&7;k=3;}
  else return 0;
  int count=k;if(i+k>n)return 0;
  while(k--){unsigned b=s[i++];if((b&0xc0)!=0x80)return 0;v=(v<<6)|(b&63);}
  if((count==1&&v<128)||(count==2&&v<2048)||(count==3&&v<65536)||v>0x10ffff||(v>=0xd800&&v<=0xdfff))return 0;
 }return 1;
}
static size_t json_size(const unsigned char *s,int n){size_t z=2;for(int i=0;i<n;i++)z+=s[i]<32?6:(s[i]=='"'||s[i]=='\\'?2:1);return z;}
// No writes, extensions, attach, or arbitrary statements. The key arrives on stdin.
static void json(const unsigned char *s,int n){putchar('"');for(int i=0;i<n;i++){unsigned char c=s[i];if(c=='"'||c=='\\'){putchar('\\');putchar(c);}else if(c<32)printf("\\u%04x",c);else putchar(c);}putchar('"');}
static int authorize(void *p,int code,const char *a,const char *b,const char *c,const char *d){
 (void)p;(void)a;(void)c;(void)d;
 if(code==SQLITE_PRAGMA && a && !strcmp(a,"table_info"))return SQLITE_OK;
 if(code==SQLITE_SELECT||code==SQLITE_READ||code==SQLITE_RECURSIVE)return SQLITE_OK;
 if(code==SQLITE_FUNCTION && b && (!strcmp(b,"count")||!strcmp(b,"length")||!strcmp(b,"hex")||!strcmp(b,"coalesce")||!strcmp(b,"substr")||!strcmp(b,"typeof")))return SQLITE_OK;
 return SQLITE_DENY;
}
int main(int argc,char **argv){
 if(argc!=2&&argc!=3)return 2;
 int batch=argc==3&&!strcmp(argv[2],"--private-batch");
 int snapshot=batch||(argc==3&&!strcmp(argv[2],"--private-copy"));if(argc==3&&!snapshot)return 2;
 char key[132]={0},profile[12]={0};
 if(!fgets(key,sizeof key,stdin)||!fgets(profile,sizeof profile,stdin))return 2;
 key[strcspn(key,"\r\n")]=0;
 size_t n=strlen(key);if(n && n!=64){fprintf(stderr,"INVALID_KEY_FORMAT\n");return 3;}
 for(size_t i=0;i<n;i++)if(!strchr("0123456789abcdefABCDEF",key[i]))return 3;
 struct stat st;char *wal=malloc(strlen(argv[1])+5);sprintf(wal,"%s-wal",argv[1]);
 if(!snapshot&&stat(wal,&st)==0&&st.st_size>0){free(wal);fprintf(stderr,"ACTIVE_WAL_REQUIRES_OFFLINE_SNAPSHOT\n");return 4;}free(wal);
 // Percent-encode path so filename characters cannot inject SQLite URI options.
 size_t len=strlen(argv[1]);char *uri=malloc(len*3+40);char *q=uri;memcpy(q,"file:",5);q+=5;
 for(size_t i=0;i<len;i++){unsigned char c=argv[1][i];if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='/'||c=='.'||c=='_'||c=='-')*q++=c;else{sprintf(q,"%%%02X",c);q+=3;}}
 strcpy(q,snapshot?"?mode=ro":"?mode=ro&immutable=1");sqlite3 *db=0;
 struct stat before,after;if(stat(argv[1],&before)){free(uri);return 5;}
 if(sqlite3_open_v2(uri,&db,SQLITE_OPEN_READONLY|SQLITE_OPEN_URI,0)!=SQLITE_OK){fprintf(stderr,"OPEN_DENIED\n");free(uri);if(db)sqlite3_close(db);return 5;}free(uri);
 if(n){char raw[70];snprintf(raw,sizeof raw,"x'%s'",key);sqlite3_key(db,raw,(int)strlen(raw));memset(raw,0,sizeof raw);}
 memset(key,0,sizeof key);
 if(!strncmp(profile,"3",1))sqlite3_exec(db,"PRAGMA cipher_compatibility=3;",0,0,0);
 else if(strncmp(profile,"4",1)){sqlite3_close(db);return 3;}
 sqlite3_exec(db,"PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;",0,0,0);
 sqlite3_limit(db,SQLITE_LIMIT_LENGTH,64*1024*1024);sqlite3_limit(db,SQLITE_LIMIT_SQL_LENGTH,65536);
 sqlite3_set_authorizer(db,authorize,0);
 char sql[65536];
 next_query:
 if(batch){
  if(!fgets(sql,sizeof sql,stdin)){sqlite3_close(db);return 0;}
  if(!strchr(sql,'\n')){sqlite3_close(db);return 7;}
 }else{size_t used=fread(sql,1,sizeof(sql)-1,stdin);sql[used]=0;}
 sqlite3_stmt *stmt=0;const char *tail=0;
 int rc=sqlite3_prepare_v2(db,sql,-1,&stmt,&tail);
 if(rc!=SQLITE_OK||!stmt||!sqlite3_stmt_readonly(stmt)){fprintf(stderr,"KEY_OR_SCHEMA_OR_QUERY_FAILED\n");if(stmt)sqlite3_finalize(stmt);sqlite3_close(db);return 6;}
 while(tail&&(*tail==' '||*tail=='\n'||*tail=='\r'||*tail=='\t'))tail++;
 if(tail&&*tail){fprintf(stderr,"MULTIPLE_STATEMENTS_DENIED\n");sqlite3_finalize(stmt);sqlite3_close(db);return 7;}
 size_t bytes=0;int rows=0;
 while((rc=sqlite3_step(stmt))==SQLITE_ROW){
  if(++rows>20000){fprintf(stderr,"ROW_LIMIT\n");rc=SQLITE_TOOBIG;break;}
  int cols=sqlite3_column_count(stmt);size_t rowbytes=3; // braces and LF
  // Count exactly what will be emitted, before writing any part of this row.
  for(int i=0;i<cols;i++){
   const char *name=sqlite3_column_name(stmt,i);rowbytes+=json_size((const unsigned char*)name,(int)strlen(name))+1+(i?1:0);
   int type=sqlite3_column_type(stmt,i);char number[64];
   if(type==SQLITE_NULL)rowbytes+=4;
   else if(type==SQLITE_INTEGER){snprintf(number,sizeof number,"%lld",sqlite3_column_int64(stmt,i));rowbytes+=strlen(number)+2;}
   else if(type==SQLITE_FLOAT){if(!isfinite(sqlite3_column_double(stmt,i))){rc=SQLITE_MISMATCH;break;}snprintf(number,sizeof number,"%.17g",sqlite3_column_double(stmt,i));rowbytes+=strlen(number);}
   else{int size=sqlite3_column_bytes(stmt,i);const unsigned char *v=sqlite3_column_blob(stmt,i);
    rowbytes+=type==SQLITE_BLOB||!utf8(v,size)?11u+2u*(size_t)size:json_size(v,size);
   }
  }
  if(rc!=SQLITE_ROW)break;
  // Reserve END + LF as well. The parent retains the same 16 MiB guard.
  if(rowbytes+4>RESPONSE_BUDGET){fprintf(stderr,"ROW_BYTES\n");rc=SQLITE_TOOBIG;break;}
  if(bytes+rowbytes+4>RESPONSE_BUDGET){fprintf(stderr,"PAGE_BYTES\n");rc=SQLITE_TOOBIG;break;}
  putchar('{');
  for(int i=0;i<cols;i++){if(i)putchar(',');const char *name=sqlite3_column_name(stmt,i);json((const unsigned char*)name,(int)strlen(name));putchar(':');int type=sqlite3_column_type(stmt,i);
   if(type==SQLITE_NULL)printf("null");
   else if(type==SQLITE_INTEGER){char number[30];snprintf(number,sizeof number,"%lld",sqlite3_column_int64(stmt,i));json((const unsigned char*)number,(int)strlen(number));}
   else if(type==SQLITE_FLOAT)printf("%.17g",sqlite3_column_double(stmt,i));
   else{int size=sqlite3_column_bytes(stmt,i);const unsigned char *v=sqlite3_column_blob(stmt,i);
    if(type==SQLITE_BLOB||!utf8(v,size)){printf("{\"$hex\":\"");for(int j=0;j<size;j++)printf("%02x",v[j]);printf("\"}");}
    else json(v,size);
   }
  }puts("}");bytes+=rowbytes;
 }
 sqlite3_finalize(stmt);if(rc!=SQLITE_DONE){fprintf(stderr,"READ_FAILED\n");sqlite3_close(db);return 8;}
 if(batch){puts("END");fflush(stdout);goto next_query;}
 sqlite3_close(db);
 if(stat(argv[1],&after)||before.st_size!=after.st_size||before.st_ino!=after.st_ino||before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec||before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec){fprintf(stderr,"SOURCE_CHANGED_DURING_READ\n");return 9;}
 wal=malloc(strlen(argv[1])+5);sprintf(wal,"%s-wal",argv[1]);int active=stat(wal,&st)==0&&st.st_size>0;free(wal);if(!snapshot&&active){fprintf(stderr,"ACTIVE_WAL_REQUIRES_OFFLINE_SNAPSHOT\n");return 4;}return 0;
}
