/* Preview / VM adapter for movie mutations. Production writes use SQLite. */
(function(root){
    const key=name=>String(name||'').trim().normalize('NFKC').toLowerCase();
    function createMovieStore({music,movies,usages}) {
        const summary=movie=>movie?{...movie,musicCount:usages.filter(u=>u.movieId===movie.id).length}:null;
        const requireMovie=id=>{const movie=movies.find(m=>m.id===id);if(!movie)throw Error('电影已不存在');return movie;};
        const append=(musicId,movieId,note)=>{
            if(usages.some(u=>u.musicId===musicId&&u.movieId===movieId))return false;
            const now=Date.now();usages.push({id:Math.max(0,...usages.map(u=>u.id))+1,musicId,movieId,note:note.trim(),createdAt:now,updatedAt:now});return true;
        };
        return (command,args)=>{
            if(command==='get_movie')return summary(movies.find(m=>m.id===args.id));
            if(command==='create_movie'){
                if(!key(args.name))throw Error('请输入电影名称');
                let movie=movies.find(m=>key(m.name)===key(args.name));
                if(!movie){const now=Date.now();movie={id:Math.max(0,...movies.map(m=>m.id))+1,name:args.name.trim(),createdAt:now,updatedAt:now};movies.push(movie);}
                return summary(movie);
            }
            if(command==='delete_movie'){
                for(let i=usages.length-1;i>=0;i--)if(usages[i].movieId===args.movieId)usages.splice(i,1);
                const index=movies.findIndex(m=>m.id===args.movieId);if(index>=0)movies.splice(index,1);
                return null;
            }
            if(command==='find_movie_by_name'){
                const movie=movies.find(m=>key(m.name)===key(args.name));
                return movie?{movie:summary(movie),alreadyLinked:usages.some(u=>u.musicId===args.musicId&&u.movieId===movie.id)}:null;
            }
            if(command==='add_music_movie_usages'){
                if(!music.some(m=>m.id===args.musicId))throw Error('音乐已不存在');
                args.movieIds.forEach(requireMovie);
                if(args.newMovieNames.some(name=>!key(name)))throw Error('请输入电影名称');
                const ids=new Set(args.movieIds);
                for(const name of args.newMovieNames){
                    let movie=movies.find(m=>key(m.name)===key(name));
                    if(!movie){const now=Date.now();movie={id:Math.max(0,...movies.map(m=>m.id))+1,name:name.trim(),createdAt:now,updatedAt:now};movies.push(movie);}
                    ids.add(movie.id);
                }
                let added=0;for(const id of ids)if(append(args.musicId,id,args.note))added++;
                return {added,alreadyLinked:ids.size-added,missingMusic:0};
            }
            if(command==='add_movie_music_usages'){
                requireMovie(args.movieId);const ids=new Set(args.musicIds);let added=0,missingMusic=0;
                for(const id of ids){if(!music.some(m=>m.id===id)){missingMusic++;continue;}if(append(id,args.movieId,args.note))added++;}
                return {added,alreadyLinked:ids.size-added-missingMusic,missingMusic};
            }
            if(command==='update_movie'){
                const movie=requireMovie(args.movieId);if(!key(args.name))throw Error('请输入电影名称');
                if(movies.some(m=>m.id!==movie.id&&key(m.name)===key(args.name)))throw Error('已有同名电影');
                movie.name=args.name.trim();movie.updatedAt=Date.now();return null;
            }
            if(command==='update_movie_usage'){
                const usage=usages.find(u=>u.id===args.usageId);if(!usage)throw Error('使用记录已不存在');usage.note=args.note.trim();usage.updatedAt=Date.now();return null;
            }
            if(command==='delete_movie_usage'){
                const index=usages.findIndex(u=>u.id===args.usageId);if(index>=0)usages.splice(index,1);return null;
            }
            return undefined;
        };
    }
    if(typeof module==='object')module.exports={createMovieStore};else root.createPreviewMovieStore=createMovieStore;
})(typeof window==='object'?window:globalThis);
